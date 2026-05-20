import { z } from 'zod';
import type { ProxyOptions } from '../@types/types.js';

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


/**
 * Build the schema for an optional profile field. The NUL refinement protects
 * the session-key separator used in agent-client.ts (KEY_SEP = '\u0000') —
 * a profile name containing NUL could otherwise collide with another key.
 */
function profileField(whenLoaded: string, extra = '') {
  const description =
    `Optional name of an authentication profile to hydrate into the browser ${whenLoaded}. ` +
    "The profile's cookies, localStorage, and IndexedDB are restored into the session before the request runs. " +
    'The profile must already exist for the API token in use — create one with Browserless.saveProfile in a live agent session first.' +
    extra;
  return z
    .string()
    .trim()
    .min(1)
    .refine((v) => !v.includes('\u0000'), {
      message: 'profile must not contain NUL characters',
    })
    .optional()
    .describe(description);
}

export const SmartScraperParamsSchema = z.object({
  url: z.url().describe('The URL to scrape (must be http or https)'),
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
  profile: profileField('before scraping'),
});


export const SmartScraperResponseSchema = z.object({
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
  profile: profileField('before the function executes'),
});


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
    .describe('Optional context object passed to the function.'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
  profile: profileField('before the download script runs'),
});


/* ------------------------------------------------------------------ */
/*  /export API – fetch a URL and stream its native content type       */
/* ------------------------------------------------------------------ */

export const ExportParamsSchema = z.object({
  url: z.url().describe('The URL to export (must be http or https)'),
  gotoOptions: z
    .object({
      waitUntil: z
        .union([
          z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']),
          z.array(
            z.enum([
              'load',
              'domcontentloaded',
              'networkidle0',
              'networkidle2',
            ]),
          ),
        ])
        .optional()
        .describe('When to consider navigation complete'),
      timeout: z
        .number()
        .optional()
        .describe('Navigation timeout in milliseconds'),
      referer: z.string().optional().describe('Referer header value'),
    })
    .optional()
    .describe('Puppeteer Page.goto() options for navigation'),
  bestAttempt: z
    .boolean()
    .optional()
    .describe('When true, proceed even if awaited events fail or timeout.'),
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
  profile: profileField('before the page is exported'),
});


/* ------------------------------------------------------------------ */
/*  Agent Browsing Protocol – typed command schemas                     */
/* ------------------------------------------------------------------ */

const WaitUntilSchema = z.enum([
  'load',
  'domcontentloaded',
  'networkidle0',
  'networkidle2',
]);

const GotoCommandSchema = z.object({
  method: z.literal('goto'),
  params: z.object({
    url: z.string().describe('The URL to navigate to'),
    waitUntil: WaitUntilSchema.optional().describe(
      'When to consider navigation complete. Defaults to "domcontentloaded". Avoid networkidle0/networkidle2 unless explicitly needed — they hang on SPAs and dynamic sites.',
    ),
    timeout: z
      .number()
      .optional()
      .describe('Navigation timeout in milliseconds'),
  }),
});

const SnapshotCommandSchema = z.object({
  method: z.literal('snapshot'),
  params: z
    .object({
      maxElements: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of elements to return (default 500)'),
      targetId: z
        .string()
        .optional()
        .describe(
          'Optional tab targetId to peek at without switching the active tab. ' +
            'Obtain via getTabs or a prior snapshot response. Omit to snapshot the active tab.',
        ),
    })
    .optional()
    .default({}),
});

const GetTabsCommandSchema = z.object({
  method: z.literal('getTabs'),
  params: z.object({}).optional().default({}),
});

const SwitchTabCommandSchema = z.object({
  method: z.literal('switchTab'),
  params: z.object({
    targetId: z
      .string()
      .describe('The targetId of the tab to make active (from getTabs).'),
  }),
});

const CreateTabCommandSchema = z.object({
  method: z.literal('createTab'),
  params: z
    .object({
      url: z
        .string()
        .optional()
        .describe(
          'URL to open in the new tab. Defaults to about:blank if omitted.',
        ),
      activate: z
        .boolean()
        .optional()
        .describe(
          'If true (default), switch to the new tab. If false, open it in the background ' +
            'and leave the current tab active.',
        ),
      waitUntil: WaitUntilSchema.optional().describe(
        'When to consider navigation complete. Only applies when activate is true. Defaults to "domcontentloaded".',
      ),
    })
    .optional()
    .default({}),
});

const CloseTabCommandSchema = z.object({
  method: z.literal('closeTab'),
  params: z.object({
    targetId: z.string().describe('The targetId of the tab to close.'),
  }),
});

const BackCommandSchema = z.object({
  method: z.literal('back'),
  params: z
    .object({
      waitUntil: WaitUntilSchema.optional().describe(
        'When to consider navigation complete. Defaults to "load".',
      ),
    })
    .optional()
    .default({}),
});

const ForwardCommandSchema = z.object({
  method: z.literal('forward'),
  params: z
    .object({
      waitUntil: WaitUntilSchema.optional().describe(
        'When to consider navigation complete. Defaults to "load".',
      ),
    })
    .optional()
    .default({}),
});

const ReloadCommandSchema = z.object({
  method: z.literal('reload'),
  params: z
    .object({
      waitUntil: WaitUntilSchema.optional().describe(
        'When to consider navigation complete. Defaults to "load".',
      ),
    })
    .optional()
    .default({}),
});

const ClickCommandSchema = z.object({
  method: z.literal('click'),
  params: z.object({
    selector: z.string().describe('CSS selector of the element to click'),
  }),
});

const TypeCommandSchema = z.object({
  method: z.literal('type'),
  params: z.object({
    selector: z.string().describe('CSS selector of the input element'),
    text: z.string().describe('Text to type into the element'),
  }),
});

const SelectCommandSchema = z.object({
  method: z.literal('select'),
  params: z.object({
    selector: z.string().describe('CSS selector of the select element'),
    value: z.string().describe('Option value to select'),
  }),
});

const CheckboxCommandSchema = z.object({
  method: z.literal('checkbox'),
  params: z.object({
    selector: z.string().describe('CSS selector of the checkbox element'),
    checked: z
      .boolean()
      .optional()
      .describe('Desired checked state (default: toggle)'),
  }),
});

const HoverCommandSchema = z.object({
  method: z.literal('hover'),
  params: z.object({
    selector: z.string().describe('CSS selector of the element to hover over'),
  }),
});

const ScrollCommandSchema = z.object({
  method: z.literal('scroll'),
  params: z
    .object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector of element to scroll (omit for page scroll)'),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('Scroll direction. Defaults to "down".'),
    })
    .optional()
    .default({}),
});

const EvaluateCommandSchema = z.object({
  method: z.literal('evaluate'),
  params: z.object({
    content: z
      .string()
      .describe('JavaScript code to execute (use IIFE syntax)'),
  }),
});

const TextCommandSchema = z.object({
  method: z.literal('text'),
  params: z
    .object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector to extract text from'),
    })
    .optional()
    .default({}),
});

const HtmlCommandSchema = z.object({
  method: z.literal('html'),
  params: z
    .object({
      selector: z.string().optional().describe('CSS selector to get HTML from'),
    })
    .optional()
    .default({}),
});

const WaitForSelectorCommandSchema = z.object({
  method: z.literal('waitForSelector'),
  params: z.object({
    selector: z.string().describe('CSS selector to wait for'),
    timeout: z
      .number()
      .optional()
      .describe('Timeout in milliseconds (recommend 5000-10000)'),
  }),
});

const WaitForNavigationCommandSchema = z.object({
  method: z.literal('waitForNavigation'),
  params: z
    .object({
      timeout: z
        .number()
        .optional()
        .describe('Timeout in milliseconds (default 30000)'),
    })
    .optional()
    .default({}),
});

const WaitForTimeoutCommandSchema = z.object({
  method: z.literal('waitForTimeout'),
  params: z.object({
    time: z
      .number()
      .describe('Time to wait in milliseconds (e.g., 3000 for 3 seconds)'),
  }),
});

const WaitForRequestCommandSchema = z.object({
  method: z.literal('waitForRequest'),
  params: z.object({
    url: z
      .string()
      .optional()
      .describe('URL pattern to match (glob-style, e.g., "*api/results*")'),
    method: z
      .string()
      .optional()
      .describe('HTTP method to match (e.g., "GET", "POST")'),
    timeout: z
      .number()
      .optional()
      .describe('Timeout in milliseconds (default 30000)'),
  }),
});

const WaitForResponseCommandSchema = z.object({
  method: z.literal('waitForResponse'),
  params: z.object({
    url: z
      .string()
      .optional()
      .describe('URL pattern to match (glob-style, e.g., "*api/results*")'),
    statuses: z
      .array(z.number())
      .optional()
      .describe('HTTP status codes to match (e.g., [200, 201])'),
    timeout: z
      .number()
      .optional()
      .describe('Timeout in milliseconds (default 30000)'),
  }),
});

const LiveURLCommandSchema = z.object({
  method: z.literal('liveURL'),
  params: z
    .object({
      timeout: z
        .number()
        .optional()
        .describe('How long the live URL stays active (ms)'),
      interactable: z
        .boolean()
        .optional()
        .describe('Allow interaction via the live URL'),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Image quality (1-100)'),
      type: z
        .enum(['jpeg', 'png'])
        .optional()
        .describe('Image format for the stream'),
      resizable: z
        .boolean()
        .optional()
        .describe('Allow resizing the browser viewport'),
    })
    .optional()
    .default({}),
});

const ScreenshotTypeSchema = z.enum(['jpeg', 'png', 'webp']);

const ScreenshotClipSchema = z.object({
  x: z.number().describe('X coordinate of the top-left corner, in CSS pixels'),
  y: z.number().describe('Y coordinate of the top-left corner, in CSS pixels'),
  width: z.number().min(1).describe('Width of the clip, in CSS pixels (>0)'),
  height: z.number().min(1).describe('Height of the clip, in CSS pixels (>0)'),
  scale: z
    .number()
    .positive()
    .optional()
    .describe('Scale factor of the clip (default 1, >0)'),
});

const ScreenshotCommandSchema = z.object({
  method: z.literal('screenshot'),
  params: z
    .object({
      type: ScreenshotTypeSchema.optional().describe(
        'Image format. Default "png". Use "jpeg" for smaller payloads on large pages.',
      ),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the entire scrollable page (default false)'),
      selector: z
        .string()
        .optional()
        .describe(
          'CSS selector of an element to screenshot. Mutually exclusive with fullPage/clip.',
        ),
      quality: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Image quality 0-100. Applies to jpeg/webp only.'),
      omitBackground: z
        .boolean()
        .optional()
        .describe('Hide default white background for transparent screenshots'),
      clip: ScreenshotClipSchema.optional().describe(
        'Region of the page to capture. Mutually exclusive with selector/fullPage.',
      ),
      waitForImages: z
        .boolean()
        .optional()
        .describe('Wait for all images on the page to load before capturing'),
      timeout: z
        .number()
        .optional()
        .describe('Timeout in milliseconds (default 30000)'),
    })
    .optional()
    .default({})
    .superRefine((params, ctx) => {
      const set = [
        params.selector !== undefined ? 'selector' : null,
        params.clip !== undefined ? 'clip' : null,
        params.fullPage === true ? 'fullPage' : null,
      ].filter((v): v is string => v !== null);

      if (set.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `selector, clip, and fullPage are mutually exclusive (got: ${set.join(', ')})`,
        });
      }
    }),
});

const CaptchaTypeSchema = z.enum([
  'cloudflare',
  'hcaptcha',
  'recaptcha',
  'recaptchaV3',
  'geetest',
  'normal',
  'friendlyCaptcha',
  'capy',
  'textCaptcha',
  'amazonWaf',
  'dataDome',
  'akamai',
  'lemin',
  'mtcaptcha',
  'slider',
]);

const SolveCommandSchema = z.object({
  method: z.literal('solve'),
  params: z
    .object({
      type: CaptchaTypeSchema.optional().describe(
        'Captcha type to solve. Omit to auto-detect.',
      ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'How long to wait for the captcha to appear (ms). Default 30000. ' +
            'Does not bound the solver itself once a captcha is found.',
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'Wait for the captcha to appear before solving (default true). ' +
            'Set false if you have already verified the widget is on screen.',
        ),
    })
    .optional()
    .default({}),
});

const CloseCommandSchema = z.object({
  method: z.literal('close'),
  params: z.object({}).optional().default({}),
});

/** Fallback for less-common BQL methods not explicitly typed above. */
const GenericCommandSchema = z.object({
  method: z.string().describe('The BQL method name'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe('Parameters for the method'),
});

/**
 * Typed command union — typed variants are tried first, generic fallback last.
 * This gives LLMs structured type information for the most common methods
 * while still allowing any BQL method to be called.
 */
const AgentCommandSchema = z.union([
  GotoCommandSchema,
  BackCommandSchema,
  ForwardCommandSchema,
  ReloadCommandSchema,
  SnapshotCommandSchema,
  GetTabsCommandSchema,
  SwitchTabCommandSchema,
  CreateTabCommandSchema,
  CloseTabCommandSchema,
  ClickCommandSchema,
  TypeCommandSchema,
  SelectCommandSchema,
  CheckboxCommandSchema,
  HoverCommandSchema,
  ScrollCommandSchema,
  EvaluateCommandSchema,
  TextCommandSchema,
  HtmlCommandSchema,
  WaitForSelectorCommandSchema,
  WaitForNavigationCommandSchema,
  WaitForTimeoutCommandSchema,
  WaitForRequestCommandSchema,
  WaitForResponseCommandSchema,
  LiveURLCommandSchema,
  SolveCommandSchema,
  ScreenshotCommandSchema,
  CloseCommandSchema,
  GenericCommandSchema,
]);

const ProxyOptionsObjectSchema = z.object({
  proxy: z
    .enum(['residential'])
    .optional()
    .describe('Routing tier. Only "residential" is supported today.'),
  proxyCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'Must be a 2-letter ISO-2 country code')
    .transform((v) => v.toLowerCase())
    .optional()
    .describe('ISO-2 country code (e.g. "us", "de"). Normalized to lowercase.'),
  proxyState: z
    .string()
    .optional()
    .describe(
      'US state name (whitespace replaced with underscores, e.g. "new_york"). ' +
        'Plan-gated — non-eligible tokens get a 401.',
    ),
  proxyCity: z
    .string()
    .optional()
    .describe(
      'City-level targeting. Requires paid/enterprise plan — non-eligible tokens get a 401.',
    ),
  proxySticky: z
    .boolean()
    .optional()
    .describe(
      'Stable IP while the underlying WebSocket stays open. Reconnects ' +
        '(idle drop, network blip, browser crash) allocate a new sticky id.',
    ),
  proxyLocaleMatch: z
    .boolean()
    .optional()
    .describe('Match navigator locale to the proxy IP country.'),
  proxyPreset: z
    .string()
    .optional()
    .describe(
      'Named proxy preset (e.g. "px_amazon01"). Supported presets are ' +
        'plan-dependent; ask Browserless support for the list available to your token.',
    ),
  externalProxyServer: z
    .string()
    .regex(
      /^https?:\/\//i,
      'externalProxyServer must start with http:// or https://',
    )
    .optional()
    .describe('Bring-your-own upstream, e.g. http://user:pass@host:port'),
});

const DEPENDENT_PROXY_FIELDS = [
  'proxyCountry',
  'proxyState',
  'proxyCity',
  'proxySticky',
  'proxyLocaleMatch',
  'proxyPreset',
] as const;

export const ProxyOptionsSchema = ProxyOptionsObjectSchema.refine(
  (v) => {
    const hasDependent = DEPENDENT_PROXY_FIELDS.some((k) => v[k] !== undefined);
    return (
      !hasDependent || v.proxy === 'residential' || !!v.externalProxyServer
    );
  },
  {
    message:
      'proxyCountry/proxyState/proxyCity/proxySticky/proxyLocaleMatch/proxyPreset ' +
      "require proxy: 'residential' or externalProxyServer to be set; otherwise the API silently ignores them.",
  },
);


export const PROXY_FIELDS = Object.keys(
  ProxyOptionsObjectSchema.shape,
) as Array<keyof ProxyOptions>;

export const AgentParamsSchema = z.object({
  method: z
    .string()
    .optional()
    .default('')
    .describe(
      'The BQL method to execute (used for single-command calls). ' +
        'When using "commands" array, this field is ignored.',
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe('Parameters for the method (used for single-command calls).'),
  commands: z
    .array(AgentCommandSchema)
    .optional()
    .describe(
      'Optional: batch multiple commands in one call. When provided, "method" and "params" ' +
        'are ignored and commands are executed sequentially. Only the final result is returned. ' +
        'Use this to batch actions that share the same page state (e.g. filling a form: ' +
        'type email + type password + click submit). Do NOT batch across navigations.',
    ),
  proxy: ProxyOptionsSchema.optional().describe(
    'Residential / external proxy config. Read once at session creation. ' +
      'Changing requires close() + a new session call.',
  ),
  profile: profileField(
    'when the agent session connects',
    ' The profile is fixed for the lifetime of the agent session; ' +
      'passing a different profile value opens a separate browser session.',
  ),
});

/* ------------------------------------------------------------------ */
/*  /search API – web search with optional scraping                    */
/* ------------------------------------------------------------------ */

export const SearchSourceSchema = z.enum(['web', 'news', 'images']);

export const SearchCategorySchema = z.enum(['github', 'research', 'pdf']);

export const TimeBasedOptionsSchema = z.enum(['day', 'week', 'month', 'year']);

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
  query: z.string().min(1).describe('The search query string'),
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
  tbs: TimeBasedOptionsSchema.optional().describe(
    'Time-based filter: "day", "week", "month", "year"',
  ),
  sources: z
    .array(SearchSourceSchema)
    .optional()
    .default(['web'])
    .describe('Search sources: "web", "news", "images" (default: ["web"])'),
  categories: z
    .array(SearchCategorySchema)
    .optional()
    .describe('Filter by categories: "github", "research", "pdf"'),
  scrapeOptions: SearchScrapeOptionsSchema.optional().describe(
    'Options for scraping each search result',
  ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});


/* ------------------------------------------------------------------ */
/*  /map API – site mapping / URL discovery                            */
/* ------------------------------------------------------------------ */

export const SitemapModeSchema = z.enum(['include', 'skip', 'only']);

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
  sitemap: SitemapModeSchema.optional()
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


export const PerformanceParamsSchema = z.object({
  url: z.url().describe('The URL to audit (must be http or https)'),
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
  profile: profileField('before the Lighthouse audit runs'),
});


/* ------------------------------------------------------------------ */
/*  /crawl API – asynchronous web crawling                             */
/* ------------------------------------------------------------------ */

export const CrawlStatusSchema = z.enum([
  'in-progress',
  'completed',
  'failed',
  'cancelled',
]);

export const PageStatusSchema = z.enum([
  'queued',
  'in-progress',
  'completed',
  'failed',
  'cancelled',
]);

export const CrawlSitemapModeSchema = z.enum(['auto', 'force', 'skip']);

export const CrawlFormatSchema = z.enum(['markdown', 'html', 'rawText']);

export const CrawlScrapeOptionsSchema = z.object({
  formats: z
    .array(CrawlFormatSchema)
    .optional()
    .default(['markdown'])
    .describe('Output formats for scraped content'),
  onlyMainContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Extract only the main content using Readability'),
  includeTags: z
    .array(z.string())
    .optional()
    .describe('HTML tag selectors to include'),
  excludeTags: z
    .array(z.string())
    .optional()
    .describe('HTML tag selectors to exclude'),
  waitFor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Time in ms to wait after page load before scraping'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Custom HTTP headers to send with each request'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Navigation timeout in milliseconds'),
});

export const CrawlParamsSchema = z.object({
  url: z.url().describe('The URL to crawl (must be http or https)'),
  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .default(100)
    .describe('Maximum number of pages to crawl (default: 100)'),
  maxDepth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(5)
    .describe('Maximum link-follow depth from the root URL (default: 5)'),
  maxRetries: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(1)
    .describe('Number of retry attempts per failed page (default: 1)'),
  allowExternalLinks: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to follow links to external domains'),
  allowSubdomains: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to follow links to subdomains'),
  sitemap: CrawlSitemapModeSchema.optional()
    .default('auto')
    .describe('Sitemap handling: "auto" (default), "force", "skip"'),
  includePaths: z
    .array(z.string())
    .optional()
    .describe('Regex patterns for URL paths to include'),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe('Regex patterns for URL paths to exclude'),
  delay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(200)
    .describe('Delay between requests in milliseconds (default: 200)'),
  scrapeOptions: CrawlScrapeOptionsSchema.optional().describe(
    'Options controlling how each page is scraped',
  ),
  waitForCompletion: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to wait for crawl completion (default: true). If false, returns immediately with crawl ID.',
    ),
  pollInterval: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5000)
    .describe(
      'Polling interval in ms when waiting for completion (default: 5000)',
    ),
  maxWaitTime: z
    .number()
    .int()
    .positive()
    .optional()
    .default(300000)
    .describe(
      'Maximum time in ms to wait for crawl completion when waitForCompletion is true (default: 300000 = 5 minutes)',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'HTTP request timeout in milliseconds for API calls (default: 30000)',
    ),
  profile: profileField('before each page is scraped'),
});


