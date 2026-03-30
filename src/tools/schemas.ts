import { z } from 'zod';

/**
 * Output formats that can be requested.
 * Mirrors the Firecrawl "formats" convention used by the enterprise API.
 */
export const ScrapeFormatSchema = z.enum([
  'markdown',
  'html',
  'screenshot',
  'pdf',
  'links',
]);

export type ScrapeFormat = z.infer<typeof ScrapeFormatSchema>;

export const PowerScraperParamsSchema = z.object({
  url: z
    .url()
    .describe('The URL to scrape (must be http or https)'),
  formats: z
    .array(ScrapeFormatSchema)
    .optional()
    .default(['markdown'])
    .describe(
      'Output formats to include: "markdown", "html", "screenshot", "pdf", "links". Defaults to ["markdown"].',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type PowerScraperParams = z.infer<typeof PowerScraperParamsSchema>;

export const PowerScraperResponseSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().nullable(),
  content: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]),
  contentType: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  strategy: z.string(),
  attempted: z.array(z.string()),
  message: z.string().nullable(),
  screenshot: z.string().nullable(),
  pdf: z.string().nullable(),
  markdown: z.string().nullable(),
  links: z.array(z.string()).nullable(),
});

export type PowerScraperResponse = z.infer<
  typeof PowerScraperResponseSchema
>;

/* ------------------------------------------------------------------ */
/*  /function API – execute custom Puppeteer code server-side          */
/* ------------------------------------------------------------------ */

export const FunctionParamsSchema = z.object({
  code: z
    .string()
    .describe(
      'JavaScript (ESM) code to execute. The default export receives ' +
      '{ page, context } and should return { data, type } where data ' +
      'is the response payload and type is the Content-Type string.',
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional context object passed to the function as the second argument.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type FunctionParams = z.infer<typeof FunctionParamsSchema>;

/* ------------------------------------------------------------------ */
/*  /download API – run code and return the file Chrome downloads      */
/* ------------------------------------------------------------------ */

export const DownloadParamsSchema = z.object({
  code: z
    .string()
    .describe(
      'JavaScript (ESM) code to execute. The default export receives ' +
      '{ page, context }. During execution the code should trigger a ' +
      'file download in the browser (e.g. clicking a download link).',
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional context object passed to the function.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type DownloadParams = z.infer<typeof DownloadParamsSchema>;

/* ------------------------------------------------------------------ */
/*  /export API – fetch a URL and stream its native content type       */
/* ------------------------------------------------------------------ */

export const ExportParamsSchema = z.object({
  url: z
    .url()
    .describe('The URL to export (must be http or https)'),
  gotoOptions: z
    .object({
      waitUntil: z
        .union([
          z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']),
          z.array(z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])),
        ])
        .optional()
        .describe('When to consider navigation complete'),
      timeout: z
        .number()
        .optional()
        .describe('Navigation timeout in milliseconds'),
      referer: z
        .string()
        .optional()
        .describe('Referer header value'),
    })
    .optional()
    .describe('Puppeteer Page.goto() options for navigation'),
  bestAttempt: z
    .boolean()
    .optional()
    .describe(
      'When true, proceed even if awaited events fail or timeout.',
    ),
  includeResources: z
    .boolean()
    .optional()
    .describe(
      'When true, bundle all linked resources (CSS, JS, images) into a ZIP file.',
    ),
  waitForTimeout: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Milliseconds to wait after page load before exporting'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type ExportParams = z.infer<typeof ExportParamsSchema>;

/* ------------------------------------------------------------------ */
/*  Generic HTTP response wrapper used by function / download / export */
/* ------------------------------------------------------------------ */

export interface GenericApiResult {
  /** Response body as text (may be base64-encoded for binary) */
  data: string;
  /** Content-Type header value */
  contentType: string;
  /** Content-Disposition header value, if any */
  contentDisposition: string | null;
  /** HTTP status code */
  statusCode: number;
  /** Whether the request succeeded (2xx) */
  ok: boolean;
  /** Size in bytes of the response body */
  size: number;
  /** Whether the data field is base64-encoded binary */
  isBinary: boolean;
}

/* ------------------------------------------------------------------ */
/*  /search API – web search with optional scraping                    */
/* ------------------------------------------------------------------ */

export const SearchSourceSchema = z.enum(['web', 'news', 'images']);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchCategorySchema = z.enum(['github', 'research', 'pdf']);
export type SearchCategory = z.infer<typeof SearchCategorySchema>;

export const TimeBasedOptionsSchema = z.enum([
  'day',
  'week',
  'month',
  'year',
]);
export type TimeBasedOptions = z.infer<typeof TimeBasedOptionsSchema>;

export const SearchScrapeOptionsSchema = z.object({
  formats: z
    .array(z.enum(['markdown', 'html', 'links', 'screenshot']))
    .optional()
    .describe('Output formats for scraped content'),
  onlyMainContent: z
    .boolean()
    .optional()
    .describe('Extract only the main content using Readability'),
  includeTags: z
    .array(z.string())
    .optional()
    .describe('Only include content from these HTML tags'),
  excludeTags: z
    .array(z.string())
    .optional()
    .describe('Exclude content from these HTML tags'),
});

export const SearchParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('The search query string'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(10)
    .describe('Maximum number of results to return (default: 10, max: 100)'),
  lang: z
    .string()
    .optional()
    .default('en')
    .describe('Language code for search results (default: "en")'),
  country: z
    .string()
    .optional()
    .describe('Country code for geo-targeted results'),
  location: z
    .string()
    .optional()
    .describe('Location string for geo-targeted results'),
  tbs: TimeBasedOptionsSchema
    .optional()
    .describe('Time-based filter: "day", "week", "month", "year"'),
  sources: z
    .array(SearchSourceSchema)
    .optional()
    .default(['web'])
    .describe('Search sources: "web", "news", "images" (default: ["web"])'),
  categories: z
    .array(SearchCategorySchema)
    .optional()
    .describe('Filter by categories: "github", "research", "pdf"'),
  scrapeOptions: SearchScrapeOptionsSchema
    .optional()
    .describe('Options for scraping each search result'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type SearchParams = z.infer<typeof SearchParamsSchema>;

export interface SearchResultBase {
  title: string;
  url: string;
  description: string;
  position?: number;
}

export interface ScrapedContent {
  markdown?: string;
  html?: string;
  links?: string[];
  screenshot?: string;
  metadata?: {
    statusCode: number | null;
    strategy?: string;
    error?: string;
  };
}

export interface WebSearchResult extends SearchResultBase, ScrapedContent {}

export interface NewsSearchResult extends WebSearchResult {
  date?: string;
  imageUrl?: string;
}

export interface ImageSearchResult {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
  position?: number;
}

export interface SearchResponseData {
  web?: WebSearchResult[];
  news?: NewsSearchResult[];
  images?: ImageSearchResult[];
}

export interface SearchResponse {
  success: boolean;
  data: SearchResponseData;
  totalResults: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  /map API – site mapping / URL discovery                            */
/* ------------------------------------------------------------------ */

export const SitemapModeSchema = z.enum(['include', 'skip', 'only']);
export type SitemapMode = z.infer<typeof SitemapModeSchema>;

export const MapParamsSchema = z.object({
  url: z
    .url()
    .describe('The base URL to start mapping from (must be http or https)'),
  search: z
    .string()
    .optional()
    .describe('Search query to order results by relevance'),
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .default(100)
    .describe('Maximum number of links to return (default: 100, max: 5000)'),
  sitemap: SitemapModeSchema
    .optional()
    .default('include')
    .describe('Sitemap handling: "include" (default), "skip", "only"'),
  includeSubdomains: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include URLs from subdomains (default: true)'),
  ignoreQueryParameters: z
    .boolean()
    .optional()
    .default(true)
    .describe('Exclude URLs with query parameters (default: true)'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export type MapParams = z.infer<typeof MapParamsSchema>;

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface MapResponse {
  success: boolean;
  links?: MapLink[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  /performance API – run Lighthouse audits                           */
/* ------------------------------------------------------------------ */

export const LighthouseCategorySchema = z.enum([
  'accessibility',
  'best-practices',
  'performance',
  'pwa',
  'seo',
]);

export type LighthouseCategory = z.infer<typeof LighthouseCategorySchema>;

export const PerformanceParamsSchema = z.object({
  url: z
    .url()
    .describe('The URL to audit (must be http or https)'),
  categories: z
    .array(LighthouseCategorySchema)
    .optional()
    .describe(
      'Lighthouse categories to audit: "accessibility", "best-practices", ' +
      '"performance", "pwa", "seo". Omit for all categories.',
    ),
  budgets: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Lighthouse performance budgets array. ' +
      'See https://developer.chrome.com/docs/lighthouse/performance/performance-budgets',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds (audits can take 30s–120s)'),
});

export type PerformanceParams = z.infer<typeof PerformanceParamsSchema>;

export interface PerformanceResponse {
  data: Record<string, unknown>;
  type: string;
}
