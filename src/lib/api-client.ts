import { compact, hashToken, isTextContentType } from './utils.js';
import type {
  ApiClient,
  CrawlCancelResponse,
  CrawlRequest,
  CrawlStartResponse,
  CrawlStatusResponse,
  DownloadRequest,
  ExportRequest,
  FunctionRequest,
  GenericApiResult,
  MapRequest,
  MapResponse,
  McpConfig,
  PerformanceRequest,
  PerformanceResponse,
  SearchRequest,
  SearchResponse,
  SmartScrapeRequest,
  SmartScrapeResult,
  SmartScraperResponse,
} from '../@types/types.js';
import { retryWithBackoff } from './retry.js';
import { ResponseCache } from './cache.js';

/**
 * Thrown when an API call references a profile that does not exist for the
 * current API token. Tools catch this and re-throw as a UserError so the LLM
 * sees a clean explanation instead of a downstream property-access crash on
 * the 404 body shape `{ error: '...' }`.
 */
export class ProfileNotFoundError extends Error {
  constructor(
    public readonly profile: string,
    serverMessage?: string,
  ) {
    super(
      serverMessage ??
        `Profile "${profile}" was not found for the configured token.`,
    );
    this.name = 'ProfileNotFoundError';
  }
}

/**
 * If the response is a 404 from a profile-aware endpoint with a profile set,
 * throw a typed ProfileNotFoundError so the caller can surface it as a
 * UserError. We treat any 404 + profile as profile-not-found regardless of
 * body shape — the error body varies (`error` / `message` / `detail` /
 * malformed JSON) and the downstream `await res.json()` would crash anyway.
 */
async function throwIfProfileMissing(
  res: Response,
  profile: string | undefined,
): Promise<void> {
  if (!profile || res.status !== 404) return;
  const body = await res
    .clone()
    .json()
    .catch(() => null);
  let serverMessage: string | undefined;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const candidates = [
      b.error,
      b.message,
      b.detail,
      Array.isArray(b.errors) ? b.errors[0] : undefined,
    ];
    serverMessage = candidates.find((v): v is string => typeof v === 'string');
  }
  throw new ProfileNotFoundError(profile, serverMessage);
}

interface ApiFetchOptions<T> {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  /** Query params. `token` is always added; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /** Defaults to 'application/json' (only relevant when `body` is set). */
  contentType?: string;
  timeout: number;
  /** If set, a 404 response throws ProfileNotFoundError. */
  profile?: string;
  /**
   * Custom response handler invoked AFTER throwIfProfileMissing.
   * If omitted, the default behavior is:
   *   - res.status >= 500 → throw `Server error ${status}: ${statusText}`
   *   - !res.ok → throw `Server error ${status}: ${body || statusText}`
   *   - else → return res.json() as T
   */
  handleResponse?: (res: Response) => Promise<T>;
  maxRetries?: number;
  /**
   * Retry predicate. Defaults to: never retry ProfileNotFoundError, and never
   * retry errors whose message starts with "Server error 4" (i.e. 4xx).
   */
  shouldRetry?: (error: Error) => boolean;
}

const defaultShouldRetry = (error: Error): boolean => {
  if (error instanceof ProfileNotFoundError) return false;
  return !error.message.startsWith('Server error 4');
};

async function defaultHandleResponse<T>(res: Response): Promise<T> {
  if (!res.ok && res.status >= 500) {
    throw new Error(`Server error ${res.status}: ${res.statusText}`);
  }
  if (!res.ok) {
    const errorBody = await res.text().catch(() => res.statusText);
    const message = errorBody.trim() || res.statusText;
    throw new Error(`Server error ${res.status}: ${message}`);
  }
  return (await res.json()) as T;
}

function apiFetch<T>(
  config: McpConfig,
  opts: ApiFetchOptions<T>,
): Promise<T> {
  const query = new URLSearchParams({ token: config.browserlessToken! });
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) query.set(k, String(v));
  }
  const url = `${config.browserlessApiUrl}${opts.path}?${query.toString()}`;
  const method = opts.method ?? 'POST';
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': opts.contentType ?? 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const handle = opts.handleResponse ?? defaultHandleResponse<T>;

  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        opts.timeout + 5000,
      );
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        await throwIfProfileMissing(res, opts.profile);
        return await handle(res);
      } finally {
        clearTimeout(timeoutId);
      }
    },
    {
      maxRetries: opts.maxRetries ?? config.maxRetries,
      baseDelayMs: 1000,
      shouldRetry: opts.shouldRetry ?? defaultShouldRetry,
    },
  );
}

/** Read a Response as text or base64-encoded binary based on its content type. */
async function readGeneric(res: Response): Promise<GenericApiResult> {
  if (!res.ok && res.status >= 500) {
    throw new Error(`Server error ${res.status}: ${res.statusText}`);
  }
  const respContentType =
    res.headers.get('content-type') ?? 'application/octet-stream';
  const contentDisposition = res.headers.get('content-disposition') ?? null;
  const isBinary = !isTextContentType(respContentType);
  let data: string;
  let size: number;
  if (isBinary) {
    const buf = Buffer.from(await res.arrayBuffer());
    size = buf.byteLength;
    data = buf.toString('base64');
  } else {
    data = await res.text();
    size = Buffer.byteLength(data, 'utf-8');
  }
  return {
    data,
    contentType: respContentType,
    contentDisposition,
    statusCode: res.status,
    ok: res.ok,
    size,
    isBinary,
  };
}

export function createApiClient(
  config: McpConfig,
  cache?: ResponseCache,
): ApiClient {
  const _cache = cache ?? new ResponseCache(config.cacheTtlMs);

  return {
    async smartScrape(params: SmartScrapeRequest): Promise<SmartScrapeResult> {
      const formats = params.formats ?? ['markdown'];
      const tokenHash = hashToken(config.browserlessToken!);
      const cacheKey = JSON.stringify({
        t: tokenHash,
        // The api URL can be overridden per-session, so two backends sharing
        // the same token must not share cache entries.
        api: config.browserlessApiUrl,
        url: params.url,
        formats: [...formats].sort(),
        // Profiles inject auth state — a cache hit across profiles would
        // leak one user's session into another's response.
        profile: params.profile ?? null,
      });

      const cached = _cache.get<SmartScraperResponse>(cacheKey);
      if (cached) {
        return { ...cached, cacheHit: true };
      }

      const timeout = params.timeout ?? config.requestTimeout;
      const result = await apiFetch<SmartScraperResponse>(config, {
        path: '/smart-scrape',
        query: { timeout, profile: params.profile },
        body: { url: params.url, formats },
        timeout,
        profile: params.profile,
      });
      _cache.set(cacheKey, result);
      return { ...result, cacheHit: false };
    },

    async runFunction(params: FunctionRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<GenericApiResult>(config, {
        path: '/function',
        query: { timeout, profile: params.profile },
        body: compact({ code: params.code, context: params.context }),
        timeout,
        profile: params.profile,
        handleResponse: readGeneric,
      });
    },

    async download(params: DownloadRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<GenericApiResult>(config, {
        path: '/download',
        query: { timeout, profile: params.profile },
        body: compact({ code: params.code, context: params.context }),
        timeout,
        profile: params.profile,
        handleResponse: readGeneric,
      });
    },

    async exportPage(params: ExportRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<GenericApiResult>(config, {
        path: '/export',
        query: { timeout, profile: params.profile },
        body: compact({
          url: params.url,
          gotoOptions: params.gotoOptions,
          bestAttempt: params.bestAttempt,
          includeResources: params.includeResources,
          waitForTimeout: params.waitForTimeout,
        }),
        timeout,
        profile: params.profile,
        handleResponse: readGeneric,
      });
    },

    async getStatus(): Promise<{ ok: boolean; message: string }> {
      try {
        const queryParams = new URLSearchParams({
          token: config.browserlessToken!,
        });
        const res = await fetch(
          `${config.browserlessApiUrl}/active?${queryParams.toString()}`,
        );
        if (res.ok) {
          return { ok: true, message: 'Browserless API is reachable' };
        }
        return { ok: false, message: `API returned status ${res.status}` };
      } catch (err) {
        return {
          ok: false,
          message: `Cannot reach API: ${(err as Error).message}`,
        };
      }
    },

    async search(params: SearchRequest): Promise<SearchResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<SearchResponse>(config, {
        path: '/search',
        query: { timeout },
        body: compact({
          query: params.query,
          limit: params.limit,
          lang: params.lang,
          country: params.country,
          location: params.location,
          tbs: params.tbs,
          sources: params.sources,
          categories: params.categories,
          scrapeOptions: params.scrapeOptions,
        }),
        timeout,
      });
    },

    async performance(
      params: PerformanceRequest,
    ): Promise<PerformanceResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      const body: Record<string, unknown> = { url: params.url };
      if (params.categories) {
        body.config = {
          extends: 'lighthouse:default',
          settings: { onlyCategories: params.categories },
        };
      }
      if (params.budgets) body.budgets = params.budgets;
      return apiFetch<PerformanceResponse>(config, {
        path: '/performance',
        query: { timeout, profile: params.profile },
        body,
        timeout,
        profile: params.profile,
      });
    },

    async map(params: MapRequest): Promise<MapResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<MapResponse>(config, {
        path: '/map',
        query: { timeout },
        body: compact({
          url: params.url,
          search: params.search,
          limit: params.limit,
          sitemap: params.sitemap,
          includeSubdomains: params.includeSubdomains,
          ignoreQueryParameters: params.ignoreQueryParameters,
        }),
        timeout,
      });
    },

    async crawl(params: CrawlRequest): Promise<CrawlStartResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      return apiFetch<CrawlStartResponse>(config, {
        // /crawl accepts token + profile as query params; no `timeout` query.
        path: '/crawl',
        query: { profile: params.profile },
        body: compact({
          url: params.url,
          limit: params.limit,
          maxDepth: params.maxDepth,
          maxRetries: params.maxRetries,
          allowExternalLinks: params.allowExternalLinks,
          allowSubdomains: params.allowSubdomains,
          sitemap: params.sitemap,
          includePaths: params.includePaths,
          excludePaths: params.excludePaths,
          delay: params.delay,
          scrapeOptions: params.scrapeOptions,
        }),
        timeout,
        profile: params.profile,
        handleResponse: async (res) => {
          if (!res.ok && res.status >= 500) {
            throw new Error(`Server error ${res.status}: ${res.statusText}`);
          }
          // The /crawl endpoint returns a structured
          // `{ success: false, error: string }` body on some 4xx responses
          // (e.g. 429 rate limit). Forward those so the tool can surface
          // them as a clean UserError. Non-JSON 4xx bodies surface as a
          // Server error so retry suppression catches them.
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            try {
              const parsed = JSON.parse(text);
              if (
                parsed &&
                typeof parsed === 'object' &&
                (parsed as { success?: unknown }).success === false
              ) {
                return parsed as CrawlStartResponse;
              }
            } catch {
              // Non-JSON body — fall through.
            }
            const message = text.trim() || res.statusText;
            throw new Error(`Server error ${res.status}: ${message}`);
          }
          return (await res.json()) as CrawlStartResponse;
        },
      });
    },

    async getCrawl(
      crawlId: string,
      skip?: number,
    ): Promise<CrawlStatusResponse> {
      return apiFetch<CrawlStatusResponse>(config, {
        path: `/crawl/${crawlId}`,
        method: 'GET',
        query: { skip: skip !== undefined && skip > 0 ? skip : undefined },
        timeout: config.requestTimeout,
        shouldRetry: (error) =>
          !error.message.startsWith('Server error 4') &&
          !error.message.includes('not found'),
        handleResponse: async (res) => {
          if (res.status === 404) throw new Error('Crawl not found');
          if (!res.ok) {
            const errorBody = await res.text().catch(() => res.statusText);
            throw new Error(`API error ${res.status}: ${errorBody}`);
          }
          return (await res.json()) as CrawlStatusResponse;
        },
      });
    },

    async cancelCrawl(crawlId: string): Promise<CrawlCancelResponse> {
      return apiFetch<CrawlCancelResponse>(config, {
        path: `/crawl/${crawlId}`,
        method: 'DELETE',
        timeout: config.requestTimeout,
        maxRetries: 0,
        shouldRetry: () => false,
        handleResponse: async (res) => {
          if (res.status === 404) throw new Error('Crawl not found');
          if (res.status === 409) {
            const body = (await res.json()) as { message?: string };
            throw new Error(
              body.message ?? 'Crawl is already in terminal state',
            );
          }
          if (!res.ok) {
            const errorBody = await res.text().catch(() => res.statusText);
            throw new Error(`API error ${res.status}: ${errorBody}`);
          }
          return (await res.json()) as CrawlCancelResponse;
        },
      });
    },
  };
}
