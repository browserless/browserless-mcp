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
/*  Agent Browsing Protocol – single generic WS passthrough tool       */
/* ------------------------------------------------------------------ */

const AgentCommandSchema = z.object({
  method: z.string().describe('The BQL method name'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe('Parameters for the method'),
});

export const AgentParamsSchema = z.object({
  method: z
    .string()
    .optional()
    .default('')
    .describe(
      'The BQL method to execute. Common methods:\n' +
      '- "goto" { url, waitUntil? } — navigate to a URL\n' +
      '- "snapshot" { maxElements? } — get interactive page elements with selectors\n' +
      '- "click" { selector } — click an element\n' +
      '- "type" { selector, text } — type into an input\n' +
      '- "screenshot" { fullPage? } — take a screenshot\n' +
      '- "text" { selector } — extract text from an element\n' +
      '- "select" { selector, value } — select dropdown option\n' +
      '- "hover" { selector } — hover over an element\n' +
      '- "scroll" { selector?, direction? } — scroll the page\n' +
      '- "evaluate" { content } — run JavaScript in the browser\n' +
      '- "waitForSelector" { selector, timeout? } — wait for element\n' +
      '- "liveURL" { timeout?, interactable?, quality?, type?, resizable? } — get a shareable live URL to stream the browser\n' +
      '- "close" — close the browser session',
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe('Parameters for the method as a JSON object.'),
  commands: z
    .array(AgentCommandSchema)
    .optional()
    .describe(
      'Optional: batch multiple commands in one call. When provided, "method" and "params" ' +
      'are ignored and commands are executed sequentially. Only the final result is returned. ' +
      'Use this to batch actions that share the same page state (e.g. filling a form: ' +
      'type email + type password + click submit). Do NOT batch across navigations.',
    ),
});

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
