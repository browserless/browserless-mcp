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
