import { z } from 'zod';
import { ProxyOptionsSchema } from '../lib/agent-client.js';

// NUL is the session-key separator (KEY_SEP) in agent-client.ts. Computed via
// fromCharCode so the literal control character never appears in source.
const NUL = String.fromCharCode(0);

export function profileField(whenLoaded: string, extra = '') {
  const description =
    `Optional name of an authentication profile to hydrate into the browser ${whenLoaded}. ` +
    "The profile's cookies, localStorage, and IndexedDB are restored into the session before the request runs. " +
    'The profile must already exist for the API token in use — create one with Browserless.saveProfile in a live agent session first.' +
    extra;
  return z
    .string()
    .trim()
    .min(1)
    .refine((v) => !v.includes(NUL), {
      message: 'profile must not contain NUL characters',
    })
    .optional()
    .describe(description);
}

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

// Fully-typed command variants, each keyed by a `method` literal so they can be
// dispatched by the discriminated union below.
const specificCommandSchemas = [
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
] as const;

const KNOWN_METHODS = new Set<string>(
  specificCommandSchemas.map((schema) => schema.shape.method.value),
);

// fallback for non typed bql methods
const GenericCommandSchema = z.object({
  method: z
    .string()
    .refine((m) => !KNOWN_METHODS.has(m), {
      message: 'method has a typed schema and is validated there, not here',
    })
    .describe('The BQL method name'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe('Parameters for the method'),
});

export const AgentCommandSchema = z.union([
  z.discriminatedUnion('method', specificCommandSchemas),
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
  proxy: ProxyOptionsSchema.optional().describe(
    'Residential / external proxy config. Read once at session creation. ' +
      'Changing requires close() + a new session call.',
  ),
  profile: profileField(
    'when the agent session connects',
    ' The profile is fixed for the lifetime of the agent session; ' +
      'passing a different profile value opens a separate browser session.',
  ),
  rationale: z
    .string()
    .optional()
    .describe(
      'A short user-facing reason for this call. HARD BUDGET: 50 characters. ' +
        'Surfaced live in interactive UIs as the progress label. Write it for ' +
        'a human watching, in present-continuous form ("Logging in", "Filling ' +
        'the search form", "Checking the time", "Closing the cookie banner"). ' +
        'If your first draft is longer than 50 chars, REWORD IT to fit — ' +
        'compress to the essence; do NOT just chop. Bad: "Read page title and ' +
        'body text to determine why snapshot is empty" (64). Good: "Diagnosing ' +
        'empty snapshot" (24). Bad: "Filling out a very detailed multi-field ' +
        'signup form" (51). Good: "Filling the signup form" (23). Never use ' +
        'jargon, raw method names ("evaluate", "click"), JS, full URLs, or ' +
        'credentials. Include exactly one per `browserless_agent` call, even ' +
        'when batching commands.',
    ),
});

/** A single validated agent command. */
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
/** The full `browserless_agent` tool params (single command, batch, proxy, profile). */
export type AgentParams = z.infer<typeof AgentParamsSchema>;
