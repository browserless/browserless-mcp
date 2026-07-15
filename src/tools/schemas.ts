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
      full: z
        .boolean()
        .optional()
        .describe(
          'Force a complete snapshot instead of a diff. Snapshots normally return ' +
            'only what changed since your previous one; set full:true when you no ' +
            'longer have that previous snapshot in context (e.g. it was summarized ' +
            'away) and need the entire element list again.',
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

const LoadSecretCommandSchema = z.object({
  method: z.literal('loadSecret'),
  params: z.object({
    ref: z
      .string()
      .describe(
        'The credential reference/alias to inject (e.g. an op:// reference). ' +
          'The secret value is resolved server-side and typed into the field — ' +
          'you never see it. Use this for ALL passwords and usernames from a ' +
          'secrets vault; never put a secret value in `type`.',
      ),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector of the input to fill. If omitted, the secret is injected ' +
          'into the currently focused element (click/focus the field first).',
      ),
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
      toDisk: z
        .boolean()
        .optional()
        .describe(
          'Save the screenshot to disk instead of returning it inline. ' +
            'You will NOT see the image; the response gives a reusable handle ' +
            '(local path in stdio, single-use GET URL over HTTP) exactly like a ' +
            'download — reuse it with uploadFile or hand it to the user. Use when ' +
            'you only need the file later, not to look at now (see file-transfers).',
        ),
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

const UploadFileCommandSchema = z.object({
  method: z.literal('uploadFile'),
  params: z.object({
    selector: z
      .string()
      .describe('CSS selector of the <input type="file"> element'),
    files: z
      .array(
        z
          .object({
            content: z
              .string()
              .optional()
              .describe(
                'Base64-encoded file content. LAST RESORT — only for tiny data ' +
                  'you already hold inline. Do NOT read a file into the ' +
                  'conversation, and never split/reassemble base64 by hand: use ' +
                  '`path` (stdio) or `handle` so the server moves the bytes.',
              ),
            handle: z
              .string()
              .optional()
              .describe(
                'A download handle from a prior getDownloads (a path in stdio ' +
                  'mode, a `browserless-download://` URI in HTTP mode). The MCP ' +
                  'server reads the stored file — works in both transports and ' +
                  'keeps the bytes out of the conversation. Use this to re-upload ' +
                  'a file you just downloaded.',
              ),
            path: z
              .string()
              .optional()
              .describe(
                'Local filesystem path to read and upload. stdio (local) mode ' +
                  'only — the MCP server reads and base64-encodes it. In HTTP ' +
                  'mode use `handle` or `content` instead.',
              ),
            name: z
              .string()
              .optional()
              .describe(
                'Filename reported to the page. Defaults to the basename of ' +
                  '`path`, else "file".',
              ),
            mimeType: z
              .string()
              .optional()
              .describe('MIME type; inferred from the extension when omitted.'),
          })
          .refine(
            (f) =>
              [f.content, f.handle, f.path].filter((s) => s !== undefined)
                .length === 1,
            {
              message:
                'Provide exactly one of "content", "handle", or "path" per file.',
            },
          ),
      )
      .min(1)
      .describe(
        'Files to attach. Combined decoded size is capped (server default ' +
          '10MB, hard max 50MB).',
      ),
  }),
});

const GetDownloadsCommandSchema = z.object({
  method: z.literal('getDownloads'),
  params: z.object({}).optional().default({}),
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
  LoadSecretCommandSchema,
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
  UploadFileCommandSchema,
  GetDownloadsCommandSchema,
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

// Proxy block for a profile-creation session. Mirrors the POST /profile body
// proxy shape (type/sticky/country/city/state/preset) so it passes straight
// through — distinct from the top-level agent proxy fields (proxy/proxyCountry…).
const CreateProfileProxySchema = z.object({
  type: z
    .literal('residential')
    .optional()
    .describe('Routing tier. Only "residential" is supported today.'),
  sticky: z
    .boolean()
    .optional()
    .describe('Keep the same IP for the lifetime of the creation session.'),
  country: z
    .string()
    .optional()
    .describe('Two-letter country code (e.g. "us").'),
  city: z.string().optional().describe('City-level targeting (plan-gated).'),
  state: z.string().optional().describe('State/region targeting (plan-gated).'),
  preset: z
    .string()
    .optional()
    .describe('Named proxy preset (plan-dependent).'),
});

const CreateProfileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((s) => /^[^\s/?#]+$/.test(s), {
        message: 'name must match /^[^\\s/?#]+$/ (no whitespace, /, ?, #)',
      })
      .describe(
        'Name to save the profile under. Reused as the saveProfile name.',
      ),
    proxy: CreateProfileProxySchema.optional(),
    browser: z.enum(['chrome', 'chromium', 'stealth']).optional(),
    stealth: z.boolean().optional(),
  })
  .describe(
    'Open this session in profile-creation mode. The MCP tool POSTs /profile ' +
      'with these params, attaches the agent WS to the returned creation session ' +
      '(non-headless, 10-minute keepalive), and expects a saveProfile call before ' +
      'close. Mutually exclusive with `profile`. Load the `auth-profile` skill ' +
      '(via browserless_skill) for the full create-then-save recipe.',
  );

export const AgentParamsSchema = z
  .object({
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
      ' `profile` binds each call to its hydrated session — you MUST pass it on ' +
        'every call in a multi-call flow, not just the first. A call that omits ' +
        '`profile` runs in the default, un-hydrated session and will look logged ' +
        'out; if that happens, re-issue the call WITH `profile` before concluding ' +
        'the session expired. A different `profile` value opens a separate session.',
    ),
    createProfile: CreateProfileSchema.optional(),
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
  })
  .refine((v) => !(v.profile && v.createProfile), {
    message:
      '`profile` (hydrate an existing profile) and `createProfile` (author a new ' +
      'one) cannot both be set',
  });

// ── Compliant surface variant (see ./compliance.ts) ──────────────────────────
// De-fanged agent surface: drops prohibited commands/config (CAPTCHA, JS, proxy,
// stealth, autologin) + raw-BQL passthrough. `.strict()` rejects removed keys server-side.
const compliantCommandSchemas = [
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
  TextCommandSchema,
  HtmlCommandSchema,
  WaitForSelectorCommandSchema,
  WaitForNavigationCommandSchema,
  WaitForTimeoutCommandSchema,
  WaitForRequestCommandSchema,
  WaitForResponseCommandSchema,
  LiveURLCommandSchema,
  ScreenshotCommandSchema,
  // No uploadFile/getDownloads: upload impersonates a human write (vendor-TOS),
  // download is the paired file-I/O — a compliant web agent reads, doesn't move files.
  CloseCommandSchema,
] as const;

/** Method names the compliant agent permits — defense-in-depth for run(). */
export const COMPLIANT_AGENT_METHODS: ReadonlySet<string> = new Set<string>(
  compliantCommandSchemas.map((s) => s.shape.method.value),
);

// No profile/createProfile: zero auth-profile capability. profile hydrates a
// saved session (see profileField) — belongs with the hidden autonomous-login skills.
export const CompliantAgentParamsSchema = z
  .object({
    commands: z
      .array(z.discriminatedUnion('method', compliantCommandSchemas))
      .min(1)
      .describe(
        'Batch of browser navigation, read, and interaction commands ' +
          '(click, type, scroll, etc.) executed sequentially against the page ' +
          'the user specifies. Only the final result is returned.',
      ),
    rationale: z
      .string()
      .optional()
      .describe(
        'Short user-facing reason for this call (<=50 chars, present-continuous).',
      ),
  })
  .strict();

export type CompliantAgentParams = z.infer<typeof CompliantAgentParamsSchema>;

/** A single validated agent command. */
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
/** The full `browserless_agent` tool params (single command, batch, proxy, profile). */
export type AgentParams = z.infer<typeof AgentParamsSchema>;
/** Params for opening a profile-creation session (POST /profile passthrough). */
export type CreateProfileParams = z.infer<typeof CreateProfileSchema>;
