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
      'When to consider navigation complete. Defaults to "load".',
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

const HoverCommandSchema = z.object({
  method: z.literal('hover'),
  params: z.object({
    selector: z
      .string()
      .describe('CSS selector of the element to hover over'),
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
      selector: z
        .string()
        .optional()
        .describe('CSS selector to get HTML from'),
    })
    .optional()
    .default({}),
});

const ScreenshotCommandSchema = z.object({
  method: z.literal('screenshot'),
  params: z
    .object({
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page'),
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

const CloseCommandSchema = z.object({
  method: z.literal('close'),
  params: z
    .object({})
    .optional()
    .default({}),
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
  SnapshotCommandSchema,
  ClickCommandSchema,
  TypeCommandSchema,
  SelectCommandSchema,
  HoverCommandSchema,
  ScrollCommandSchema,
  EvaluateCommandSchema,
  TextCommandSchema,
  HtmlCommandSchema,
  ScreenshotCommandSchema,
  WaitForSelectorCommandSchema,
  LiveURLCommandSchema,
  CloseCommandSchema,
  GenericCommandSchema,
]);

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
