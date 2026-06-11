import type { z } from 'zod';
import type WebSocket from 'ws';
import type {
  ScrapeFormatSchema,
  SmartScraperParamsSchema,
  SmartScraperResponseSchema,
} from '../tools/smartscraper.js';
import type { FunctionParamsSchema } from '../tools/function.js';
import type { DownloadParamsSchema } from '../tools/download.js';
import type { ExportParamsSchema } from '../tools/export.js';
import type {
  SearchSourceSchema,
  SearchCategorySchema,
  TimeBasedOptionsSchema,
  SearchParamsSchema,
} from '../tools/search.js';
import type { SitemapModeSchema, MapParamsSchema } from '../tools/map.js';
import type {
  LighthouseCategorySchema,
  PerformanceParamsSchema,
} from '../tools/performance.js';
import type {
  CrawlStatusSchema,
  PageStatusSchema,
  CrawlSitemapModeSchema,
  CrawlFormatSchema,
  CrawlParamsSchema,
} from '../tools/crawl.js';
import type { AgentParamsSchema } from '../tools/agent.js';
import type { CreateProfileParams } from '../tools/schemas.js';
import type { ProxyOptionsSchema } from '../lib/agent-client.js';

/* ------------------------------------------------------------------ */
/*  Session & auth                                                     */
/* ------------------------------------------------------------------ */

export interface BrowserlessSession extends Record<string, unknown> {
  token: string;
  apiUrl: string;
  /**
   * A pre-created browser session id to ATTACH to (via /chromium/agent?sessionId),
   * threaded by the caller through the `x-browserless-session-id` header. Used by
   * the autologin runner, which does POST /profile itself and hands the agent the
   * resulting id instead of letting the model open a `createProfile` session.
   */
  attachSessionId?: string;
}

export interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  app_metadata?: {
    accountId?: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export interface McpConfig {
  browserlessToken?: string;
  browserlessApiUrl: string;
  transport: 'stdio' | 'httpStream';
  port: number;
  requestTimeout: number;
  maxRetries: number;
  cacheTtlMs: number;
  analyticsEnabled: boolean;
  sqsQueueUrl?: string;
  sqsRegion: string;
  oauthEnabled: boolean;
  supabaseUrl: string;
  supabaseOAuthClientId: string;
  supabaseOAuthClientSecret: string;
  supabaseServiceRoleKey: string;
  mcpBaseUrl: string;
  redisUrl?: string;
  oauthAllowedRedirectUriPatterns: string[];
}

/* ------------------------------------------------------------------ */
/*  Analytics                                                          */
/* ------------------------------------------------------------------ */

export interface AnalyticsEvent {
  event_type: string;
  time: number;
  session_id?: number;
  event_properties: Record<string, unknown> & { token: string };
}

/* ------------------------------------------------------------------ */
/*  Retry                                                              */
/* ------------------------------------------------------------------ */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  shouldRetry?: (error: Error) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Agent protocol                                                     */
/* ------------------------------------------------------------------ */

export interface AgentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentError {
  code?: string;
  message: string;
  retryable?: boolean;
  suggestion?: string;
  snapshot?: SnapshotResult;
}

export interface AgentResponse {
  id: number;
  result?: unknown;
  error?: AgentError;
}

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  selector: string;
  tag: string;
  text?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  id?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  required?: boolean;
  ariaLabel?: string;
}

export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  time: number;
  tabs?: TabInfo[];
  activeTargetId?: string | null;
  detectedChallenges?: string[];
}

export interface ActiveSession {
  ws: WebSocket;
  msgId: number;
  // Identity fields: these feed the session-cache key (see getSessionKey).
  // Mutating them post-creation would desync the cache, so they're readonly.
  readonly apiUrl: string;
  readonly token: string;
  readonly proxy?: ProxyOptions;
  readonly profile?: string;
  // When set, this session was opened in profile-creation mode: the WS is bound
  // to a creation session from POST /profile rather than a fresh launch. Feeds
  // the session-cache key (see getSessionKey), so it's readonly.
  readonly createProfile?: CreateProfileParams;
  // The creation session id returned by POST /profile. Reconnects attach to it
  // via /chromium/agent?sessionId rather than launching a new browser.
  creationSessionId?: string;
  reconnecting?: Promise<WebSocket>;
  skillState: SkillFireState;
  lastUsedAt: number;
  lastUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  Error classifier                                                   */
/* ------------------------------------------------------------------ */

export type ErrorCategory =
  | 'SELECTOR_MISS'
  | 'SESSION_LOST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'INVALID_PARAMS'
  | 'UNKNOWN';

export interface ClassifiedError {
  category: ErrorCategory;
  code?: string;
  status?: number;
  recovery: string;
}

export interface ClassifyInput {
  err: AgentError | { code?: string; message: string; status?: number };
  cmd: { method: string; params: Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/*  Skills                                                             */
/* ------------------------------------------------------------------ */

export type SkillId =
  | 'shadow-dom'
  | 'cookie-consent'
  | 'modals'
  | 'captchas'
  | 'snapshot-misses'
  | 'dynamic-content'
  | 'screenshots'
  | 'tabs'
  | 'autonomous-login'
  | 'auth-profile';

export interface DetectContext {
  snapshot?: SnapshotResult;
  error?: AgentError;
  cmd?: { method: string; params: Record<string, unknown> };
  resp?: unknown;
  apiUrl?: string;
}

export interface SkillFireState {
  fired: Map<SkillId, number>;
  cmdIndex: number;
}

/**
 * A single predicate evaluated against a DetectContext. Predicates compose
 * via Trigger (AND-clause) and SkillSpec.triggers (OR of AND-clauses).
 */
export type Predicate =
  | {
      kind: 'snapshot.has-element';
      roles?: string[];
      nameRegex?: RegExp;
      selectorPrefix?: string;
    }
  | { kind: 'snapshot.has-input-type'; type: string }
  | { kind: 'snapshot.url-match'; regex: RegExp }
  | { kind: 'snapshot.has-detected-challenge' }
  | { kind: 'snapshot.tabs-at-least'; count: number }
  | { kind: 'snapshot.element-cap-hit' }
  | { kind: 'error.code'; codes: string[] }
  | { kind: 'error.message-match'; regex: RegExp }
  | { kind: 'command.method'; methods: string[] }
  | { kind: 'command.method-prefix'; prefix: string }
  | { kind: 'command.selector-not-deep' };

/** AND-clause: every predicate must match. */
export type Trigger = Predicate[];

export interface SkillSpec {
  id: SkillId;
  path: string;
  cloudOnly?: boolean;
  refireAfter?: number;
  /** OR of triggers; each trigger is an AND-clause of predicates. */
  triggers: Trigger[];
}

export interface Skill extends SkillSpec {
  body: string;
}

/* ------------------------------------------------------------------ */
/*  Zod-inferred parameter & response types                            */
/* ------------------------------------------------------------------ */

export type ScrapeFormat = z.infer<typeof ScrapeFormatSchema>;
export type SmartScraperParams = z.infer<typeof SmartScraperParamsSchema>;
export type SmartScraperResponse = z.infer<typeof SmartScraperResponseSchema>;
export type FunctionParams = z.infer<typeof FunctionParamsSchema>;
export type DownloadParams = z.infer<typeof DownloadParamsSchema>;
export type ExportParams = z.infer<typeof ExportParamsSchema>;
export type ProxyOptions = z.infer<typeof ProxyOptionsSchema>;
export type SearchSource = z.infer<typeof SearchSourceSchema>;
export type SearchCategory = z.infer<typeof SearchCategorySchema>;
export type TimeBasedOptions = z.infer<typeof TimeBasedOptionsSchema>;
export type SearchParams = z.infer<typeof SearchParamsSchema>;
export type SitemapMode = z.infer<typeof SitemapModeSchema>;
export type MapParams = z.infer<typeof MapParamsSchema>;
export type LighthouseCategory = z.infer<typeof LighthouseCategorySchema>;
export type PerformanceParams = z.infer<typeof PerformanceParamsSchema>;
export type CrawlStatus = z.infer<typeof CrawlStatusSchema>;
export type PageStatus = z.infer<typeof PageStatusSchema>;
export type CrawlSitemapMode = z.infer<typeof CrawlSitemapModeSchema>;
export type CrawlFormat = z.infer<typeof CrawlFormatSchema>;
export type CrawlParams = z.infer<typeof CrawlParamsSchema>;
export type AgentParams = z.infer<typeof AgentParamsSchema>;

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
/*  Search                                                             */
/* ------------------------------------------------------------------ */

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
/*  Map                                                                */
/* ------------------------------------------------------------------ */

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
/*  Performance                                                        */
/* ------------------------------------------------------------------ */

export interface PerformanceResponse {
  data: Record<string, unknown>;
  type: string;
}

/* ------------------------------------------------------------------ */
/*  Crawl                                                              */
/* ------------------------------------------------------------------ */

export interface CrawlStartResponse {
  success: boolean;
  id: string;
  url: string;
  error?: string;
}

export interface CrawlPageMetadata {
  title: string | null;
  description: string | null;
  language: string | null;
  scrapedAt: string | null;
  sourceURL: string;
  statusCode: number | null;
  error: string | null;
}

export interface CrawlPageResult {
  status: PageStatus;
  contentUrl: string | null;
  metadata: CrawlPageMetadata;
}

export interface CrawlStatusResponse {
  status: CrawlStatus;
  total: number;
  completed: number;
  failed: number;
  expiresAt: string | null;
  next: string | null;
  data: CrawlPageResult[];
}

/* ------------------------------------------------------------------ */
/*  API client requests, results, and interface                        */
/* ------------------------------------------------------------------ */

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
