import { createHash } from 'node:crypto';
import type { McpConfig } from '../config.js';
import type {
  PowerScraperResponse,
  ScrapeFormat,
  GenericApiResult,
  MapResponse,
  SitemapMode,
} from '../tools/schemas.js';
import { retryWithBackoff } from './retry.js';
import { ResponseCache } from './cache.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
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

export interface PowerScrapeRequest {
  url: string;
  formats?: ScrapeFormat[];
  timeout?: number;
}

export type PowerScrapeResult = PowerScraperResponse & { cacheHit: boolean };

export interface FunctionRequest {
  code: string;
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface DownloadRequest {
  code: string;
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface ExportRequest {
  url: string;
  gotoOptions?: Record<string, unknown>;
  bestAttempt?: boolean;
  includeResources?: boolean;
  waitForTimeout?: number;
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

export interface ApiClient {
  powerScrape(params: PowerScrapeRequest): Promise<PowerScrapeResult>;
  runFunction(params: FunctionRequest): Promise<GenericApiResult>;
  download(params: DownloadRequest): Promise<GenericApiResult>;
  exportPage(params: ExportRequest): Promise<GenericApiResult>;
  map(params: MapRequest): Promise<MapResponse>;
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
  ): Promise<GenericApiResult> {
    const queryParams = new URLSearchParams({
      token: config.browserlessToken!,
      timeout: String(timeout),
    });

    const apiUrl = `${config.browserlessApiUrl}${path}?${queryParams.toString()}`;

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
            headers: { 'Content-Type': contentType },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!res.ok && res.status >= 500) {
            throw new Error(
              `Server error ${res.status}: ${res.statusText}`,
            );
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
          return !error.message.startsWith('Server error 4');
        },
      },
    );
  }

  return {
    /* ---- powerScrape (existing) ---------------------------------- */
    async powerScrape(
      params: PowerScrapeRequest,
    ): Promise<PowerScrapeResult> {
      const formats = params.formats ?? ['markdown'];
      const tokenHash = hashToken(config.browserlessToken!);
      const cacheKey = JSON.stringify({
        t: tokenHash,
        url: params.url,
        formats: [...formats].sort(),
      });

      const cached = _cache.get<PowerScraperResponse>(cacheKey);
      if (cached) {
        return { ...cached, cacheHit: true };
      }

      const timeout = params.timeout ?? config.requestTimeout;
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });

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

            if (!res.ok && res.status >= 500) {
              throw new Error(
                `Server error ${res.status}: ${res.statusText}`,
              );
            }

            return (await res.json()) as PowerScraperResponse;
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
      return postGeneric('/function', body, 'application/json', timeout);
    },

    /* ---- download (/download) ------------------------------------ */
    async download(params: DownloadRequest): Promise<GenericApiResult> {
      const timeout = params.timeout ?? config.requestTimeout;
      const body: Record<string, unknown> = { code: params.code };
      if (params.context !== undefined) {
        body.context = params.context;
      }
      return postGeneric('/download', body, 'application/json', timeout);
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
      return postGeneric('/export', body, 'application/json', timeout);
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
      if (params.includeSubdomains !== undefined) body.includeSubdomains = params.includeSubdomains;
      if (params.ignoreQueryParameters !== undefined) body.ignoreQueryParameters = params.ignoreQueryParameters;

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
              throw new Error(
                `Server error ${res.status}: ${res.statusText}`,
              );
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
  };
}
