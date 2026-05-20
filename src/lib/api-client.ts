import { createHash } from 'node:crypto';
import type { McpConfig } from '../config.js';
import type {
  SmartScraperResponse,
  ScrapeFormat,
  GenericApiResult,
  SearchResponse,
  SearchSource,
  SearchCategory,
  TimeBasedOptions,
  MapResponse,
  SitemapMode,
  LighthouseCategory,
  PerformanceResponse,
  CrawlStartResponse,
  CrawlStatusResponse,
  CrawlSitemapMode,
  CrawlFormat,
} from '../tools/schemas.js';
import { retryWithBackoff } from './retry.js';
import { ResponseCache } from './cache.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

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

/** Content-Types that should be treated as text (not base64-encoded). */
const TEXT_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/xhtml+xml',
  'application/ld+json',
];

function isTextContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return TEXT_CONTENT_TYPES.some((prefix) => lower.includes(prefix));
}

export interface SmartScrapeRequest {
  url: string;
  formats?: ScrapeFormat[];
  timeout?: number;
  profile?: string;
}

export type SmartScrapeResult = SmartScraperResponse & { cacheHit: boolean };

export interface FunctionRequest {
  code: string;
  context?: Record<string, unknown>;
  timeout?: number;
  profile?: string;
}

export interface DownloadRequest {
  code: string;
  context?: Record<string, unknown>;
  timeout?: number;
  profile?: string;
}

export interface ExportRequest {
  url: string;
  gotoOptions?: Record<string, unknown>;
  bestAttempt?: boolean;
  includeResources?: boolean;
  waitForTimeout?: number;
  timeout?: number;
  profile?: string;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  lang?: string;
  country?: string;
  location?: string;
  tbs?: TimeBasedOptions;
  sources?: SearchSource[];
  categories?: SearchCategory[];
  scrapeOptions?: {
    formats?: string[];
    onlyMainContent?: boolean;
    includeTags?: string[];
    excludeTags?: string[];
  };
  timeout?: number;
}

export interface MapRequest {
  url: string;
  search?: string;
  limit?: number;
  sitemap?: SitemapMode;
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  timeout?: number;
}

export interface PerformanceRequest {
  url: string;
  categories?: LighthouseCategory[];
  budgets?: Array<Record<string, unknown>>;
  timeout?: number;
  profile?: string;
}

export interface CrawlRequest {
  url: string;
  limit?: number;
  maxDepth?: number;
  maxRetries?: number;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  sitemap?: CrawlSitemapMode;
  includePaths?: string[];
  excludePaths?: string[];
  delay?: number;
  scrapeOptions?: {
    formats?: CrawlFormat[];
    onlyMainContent?: boolean;
    includeTags?: string[];
    excludeTags?: string[];
    waitFor?: number;
    headers?: Record<string, string>;
    timeout?: number;
  };
  timeout?: number;
  profile?: string;
}

export interface CrawlCancelResponse {
  status: 'cancelled';
}

export interface ApiClient {
  smartScrape(params: SmartScrapeRequest): Promise<SmartScrapeResult>;
  runFunction(params: FunctionRequest): Promise<GenericApiResult>;
  download(params: DownloadRequest): Promise<GenericApiResult>;
  exportPage(params: ExportRequest): Promise<GenericApiResult>;
  search(params: SearchRequest): Promise<SearchResponse>;
  map(params: MapRequest): Promise<MapResponse>;
  performance(params: PerformanceRequest): Promise<PerformanceResponse>;
  crawl(params: CrawlRequest): Promise<CrawlStartResponse>;
  getCrawl(crawlId: string, skip?: number): Promise<CrawlStatusResponse>;
  cancelCrawl(crawlId: string): Promise<CrawlCancelResponse>;
  getStatus(): Promise<{ ok: boolean; message: string }>;
}

export function createApiClient(
  config: McpConfig,
  cache?: ResponseCache,
): ApiClient {
  const _cache = cache ?? new ResponseCache(config.cacheTtlMs);

  /**
   * Shared helper: POST to a Browserless endpoint and return a
   * GenericApiResult that works for /function, /download, and /export.
   */
  async function postGeneric(
    path: string,
    body: Record<string, unknown>,
    contentType: string,
    timeout: number,
    profile?: string,
  ): Promise<GenericApiResult> {
    const queryParams = new URLSearchParams({
      token: config.browserlessToken!,
      timeout: String(timeout),
    });
    if (profile) {
      queryParams.set('profile', profile);
    }

    const apiUrl = `${config.browserlessApiUrl}${path}?${queryParams.toString()}`;

    return retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout + 5000);

        try {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          await throwIfProfileMissing(res, profile);

          if (!res.ok && res.status >= 500) {
            throw new Error(`Server error ${res.status}: ${res.statusText}`);
          }

          const respContentType =
            res.headers.get('content-type') ?? 'application/octet-stream';
          const contentDisposition =
            res.headers.get('content-disposition') ?? null;

          const isBinary = !isTextContentType(respContentType);

          let data: string;
          let size: number;

          if (isBinary) {
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            size = buffer.byteLength;
            data = buffer.toString('base64');
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
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxRetries: config.maxRetries,
        baseDelayMs: 1000,
        shouldRetry: (error: Error) => {
          if (error instanceof ProfileNotFoundError) return false;
          return !error.message.startsWith('Server error 4');
        },
      },
    );
  }

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
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });
      if (params.profile) {
        queryParams.set('profile', params.profile);
      }

      const apiUrl = `${config.browserlessApiUrl}/smart-scrape?${queryParams.toString()}`;

      const body = {
        url: params.url,
        formats,
      };

      const result = await retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            await throwIfProfileMissing(res, params.profile);

            if (!res.ok && res.status >= 500) {
              throw new Error(`Server error ${res.status}: ${res.statusText}`);
            }

            // Reject any remaining 4xx before parsing or caching — a 400/401/403
            // body must not be returned as a valid SmartScraperResponse, and
            // must not poison the cache. The `Server error` prefix also lets
            // the existing retry-suppression predicate skip these.
            if (!res.ok) {
              const errorBody = await res.text().catch(() => res.statusText);
              const message = errorBody.trim() || res.statusText;
              throw new Error(`Server error ${res.status}: ${message}`);
            }

            return (await res.json()) as SmartScraperResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            if (error instanceof ProfileNotFoundError) return false;
            return !error.message.startsWith('Server error 4');
          },
        },
      );

      _cache.set(cacheKey, result);
      return { ...result, cacheHit: false };
    },

    /* ---- runFunction (/function) --------------------------------- */
    async runFunction(params: FunctionRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      const body: Record<string, unknown> = { code: params.code };
      if (params.context !== undefined) {
        body.context = params.context;
      }
      return postGeneric(
        '/function',
        body,
        'application/json',
        timeout,
        params.profile,
      );
    },

    /* ---- download (/download) ------------------------------------ */
    async download(params: DownloadRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      const body: Record<string, unknown> = { code: params.code };
      if (params.context !== undefined) {
        body.context = params.context;
      }
      return postGeneric(
        '/download',
        body,
        'application/json',
        timeout,
        params.profile,
      );
    },

    /* ---- exportPage (/export) ------------------------------------ */
    async exportPage(params: ExportRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      const body: Record<string, unknown> = { url: params.url };
      if (params.gotoOptions !== undefined) {
        body.gotoOptions = params.gotoOptions;
      }
      if (params.bestAttempt !== undefined) {
        body.bestAttempt = params.bestAttempt;
      }
      if (params.includeResources !== undefined) {
        body.includeResources = params.includeResources;
      }
      if (params.waitForTimeout !== undefined) {
        body.waitForTimeout = params.waitForTimeout;
      }
      return postGeneric(
        '/export',
        body,
        'application/json',
        timeout,
        params.profile,
      );
    },

    /* ---- getStatus (existing) ------------------------------------ */
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
        return {
          ok: false,
          message: `API returned status ${res.status}`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `Cannot reach API: ${(err as Error).message}`,
        };
      }
    },

    /* ---- search (/search) ---------------------------------------- */
    async search(params: SearchRequest): Promise<SearchResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });

      const apiUrl = `${config.browserlessApiUrl}/search?${queryParams.toString()}`;

      const body: Record<string, unknown> = {
        query: params.query,
      };
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.lang !== undefined) body.lang = params.lang;
      if (params.country !== undefined) body.country = params.country;
      if (params.location !== undefined) body.location = params.location;
      if (params.tbs !== undefined) body.tbs = params.tbs;
      if (params.sources !== undefined) body.sources = params.sources;
      if (params.categories !== undefined) body.categories = params.categories;
      if (params.scrapeOptions !== undefined)
        body.scrapeOptions = params.scrapeOptions;

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errorBody = await res.text();
              const message = errorBody.trim() || res.statusText;
              throw new Error(`Server error ${res.status}: ${message}`);
            }

            return (await res.json()) as SearchResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            return !error.message.startsWith('Server error 4');
          },
        },
      );
    },

    /* ---- performance (/performance) ------------------------------ */
    async performance(
      params: PerformanceRequest,
    ): Promise<PerformanceResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });
      if (params.profile) {
        queryParams.set('profile', params.profile);
      }

      const apiUrl = `${config.browserlessApiUrl}/performance?${queryParams.toString()}`;

      const body: Record<string, unknown> = {
        url: params.url,
      };

      if (params.categories) {
        body.config = {
          extends: 'lighthouse:default',
          settings: {
            onlyCategories: params.categories,
          },
        };
      }

      if (params.budgets) {
        body.budgets = params.budgets;
      }

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            await throwIfProfileMissing(res, params.profile);

            if (!res.ok && res.status >= 500) {
              throw new Error(`Server error ${res.status}: ${res.statusText}`);
            }

            if (!res.ok) {
              const text = await res.text();
              throw new Error(
                `Server error ${res.status}: ${text.slice(0, 500)}`,
              );
            }

            return (await res.json()) as PerformanceResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            if (error instanceof ProfileNotFoundError) return false;
            return !error.message.startsWith('Server error 4');
          },
        },
      );
    },

    /* ---- map (/map) ---------------------------------------------- */
    async map(params: MapRequest): Promise<MapResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });

      const apiUrl = `${config.browserlessApiUrl}/map?${queryParams.toString()}`;

      const body: Record<string, unknown> = {
        url: params.url,
      };
      if (params.search !== undefined) body.search = params.search;
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.sitemap !== undefined) body.sitemap = params.sitemap;
      if (params.includeSubdomains !== undefined)
        body.includeSubdomains = params.includeSubdomains;
      if (params.ignoreQueryParameters !== undefined)
        body.ignoreQueryParameters = params.ignoreQueryParameters;

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            if (!res.ok && res.status >= 500) {
              throw new Error(`Server error ${res.status}: ${res.statusText}`);
            }

            return (await res.json()) as MapResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            return !error.message.startsWith('Server error 4');
          },
        },
      );
    },

    /* ---- crawl (POST /crawl) ------------------------------------- */
    async crawl(params: CrawlRequest): Promise<CrawlStartResponse> {
      const timeout = params.timeout ?? config.requestTimeout;
      // Note: /crawl endpoint accepts 'token' and 'profile' as query params
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
      });
      if (params.profile) {
        queryParams.set('profile', params.profile);
      }

      const apiUrl = `${config.browserlessApiUrl}/crawl?${queryParams.toString()}`;

      const body: Record<string, unknown> = {
        url: params.url,
      };
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.maxDepth !== undefined) body.maxDepth = params.maxDepth;
      if (params.maxRetries !== undefined) body.maxRetries = params.maxRetries;
      if (params.allowExternalLinks !== undefined)
        body.allowExternalLinks = params.allowExternalLinks;
      if (params.allowSubdomains !== undefined)
        body.allowSubdomains = params.allowSubdomains;
      if (params.sitemap !== undefined) body.sitemap = params.sitemap;
      if (params.includePaths !== undefined)
        body.includePaths = params.includePaths;
      if (params.excludePaths !== undefined)
        body.excludePaths = params.excludePaths;
      if (params.delay !== undefined) body.delay = params.delay;
      if (params.scrapeOptions !== undefined)
        body.scrapeOptions = params.scrapeOptions;

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            await throwIfProfileMissing(res, params.profile);

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
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            if (error instanceof ProfileNotFoundError) return false;
            return !error.message.startsWith('Server error 4');
          },
        },
      );
    },

    /* ---- getCrawl (GET /crawl/{id}) ------------------------------ */
    async getCrawl(
      crawlId: string,
      skip?: number,
    ): Promise<CrawlStatusResponse> {
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
      });
      if (skip !== undefined && skip > 0) {
        queryParams.set('skip', String(skip));
      }

      const apiUrl = `${config.browserlessApiUrl}/crawl/${crawlId}?${queryParams.toString()}`;

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            config.requestTimeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'GET',
              signal: controller.signal,
            });

            // Handle specific error codes first
            if (res.status === 404) {
              throw new Error('Crawl not found');
            }

            // Reject all non-OK responses to avoid treating error bodies as valid data
            if (!res.ok) {
              const errorBody = await res.text().catch(() => res.statusText);
              throw new Error(`API error ${res.status}: ${errorBody}`);
            }

            return (await res.json()) as CrawlStatusResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            return (
              !error.message.startsWith('Server error 4') &&
              !error.message.includes('not found')
            );
          },
        },
      );
    },

    /* ---- cancelCrawl (DELETE /crawl/{id}) ------------------------ */
    async cancelCrawl(crawlId: string): Promise<CrawlCancelResponse> {
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
      });

      const apiUrl = `${config.browserlessApiUrl}/crawl/${crawlId}?${queryParams.toString()}`;

      return retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            config.requestTimeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'DELETE',
              signal: controller.signal,
            });

            // Handle specific error codes first
            if (res.status === 404) {
              throw new Error('Crawl not found');
            }

            if (res.status === 409) {
              const body = (await res.json()) as { message?: string };
              throw new Error(
                body.message ?? 'Crawl is already in terminal state',
              );
            }

            // Reject all non-OK responses to avoid treating error bodies as valid data
            if (!res.ok) {
              const errorBody = await res.text().catch(() => res.statusText);
              throw new Error(`API error ${res.status}: ${errorBody}`);
            }

            return (await res.json()) as CrawlCancelResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: 0, // Don't retry DELETE operations
          baseDelayMs: 1000,
          shouldRetry: () => false,
        },
      );
    },
  };
}
