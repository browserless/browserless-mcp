import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z, type ZodType } from 'zod';
import { createApiClient, ProfileNotFoundError } from './api-client.js';
import { ResponseCache } from './cache.js';
import { AnalyticsHelper } from './analytics.js';
import type {
  ApiClient,
  BrowserlessSession,
  McpConfig,
} from '../@types/types.js';

/**
 * Minimal log surface tools use. Tools only call the level methods with a
 * string today, so the extra `data` param FastMCP's Logger accepts is just
 * dropped here. Optional extra params on the source remain assignable.
 */
interface ToolLog {
  debug(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  streamingHint?: boolean;
}

export interface ToolRunContext<P> {
  client: ApiClient;
  params: P;
  log: ToolLog;
  /** For tools that fire analytics from inside their own logic (e.g. crawl polling). */
  analytics?: AnalyticsHelper;
  token: string;
  apiUrl: string;
  reportProgress: (progress: {
    progress: number;
    total: number;
  }) => Promise<void>;
  /** MCP session id (httpStream transport) or undefined for stdio — used by agent tool. */
  sessionId: string | undefined;
}

export interface ToolDefinition<P, R> {
  name: string;
  description: string;
  parameters: ZodType<P>;
  annotations?: ToolAnnotations;
  /** Throw UserError if any URL in params is invalid. Runs before progress 0. */
  validateUrl?: (params: P) => void;
  /** Override the default ProfileNotFoundError → UserError message. */
  profileNotFoundMessage?: (profile: string) => string;
  /**
   * Persistent ResponseCache shared across executions of this tool. Pass
   * a cache here if the tool relies on caching (e.g. smartScrape) — without
   * it createApiClient builds a fresh per-execution cache.
   */
  cache?: ResponseCache;
  /** Main tool logic. Returns the value `format` will render. */
  run: (ctx: ToolRunContext<P>) => Promise<R>;
  /** Render the result into MCP content blocks. May throw UserError. */
  format: (result: R, params: P) => Content[];
  /**
   * Extra analytics properties beyond the base `{ token, tool, api_url }`.
   * Fired AFTER `run` completes and BEFORE `format` runs — so analytics
   * still fire if `format` throws (e.g. on `!response.ok`). Omit when the
   * tool fires its own intra-execution events.
   */
  analyticsProps?: (params: P, result: R) => Record<string, unknown>;
}

const defaultProfileMessage = (profile: string): string =>
  `Profile "${profile}" was not found for the configured API token. ` +
  `Create the profile with Browserless.saveProfile in a live session first, ` +
  `or omit the profile parameter.`;

/**
 * Build the schema for an optional profile field. The NUL refinement protects
 * the session-key separator used in agent-client.ts (KEY_SEP = '\u0000') — a
 * profile name containing NUL could otherwise collide with another key.
 */
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
    .refine((v) => !v.includes('\u0000'), {
      message: 'profile must not contain NUL characters',
    })
    .optional()
    .describe(description);
}

/** Throw a UserError if `url` is not an http/https URL. */
export function validateHttpUrl(url: string): void {
  const urlObj = new URL(url);
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new UserError(
      `Invalid URL protocol "${urlObj.protocol}". Only http and https are supported.`,
    );
  }
}

export function defineTool<P, R>(
  server: FastMCP,
  config: McpConfig,
  analytics: AnalyticsHelper | undefined,
  def: ToolDefinition<P, R>,
): void {
  server.addTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    annotations: def.annotations,
    execute: async (args, { reportProgress, session, sessionId, log }) => {
      const params = args as P;
      // Single localized cast — FastMCP types session as Record<string, unknown>
      // for the unconstrained generic. Tools see the typed session via this helper
      // and never cast token/apiUrl themselves.
      const s = session as BrowserlessSession | undefined;

      const token = s?.token ?? config.browserlessToken;
      if (!token) {
        throw new UserError(
          'No Browserless API token provided. ' +
            'For stdio: set the BROWSERLESS_TOKEN environment variable. ' +
            'For HTTP: pass Authorization: Bearer <token> header.',
        );
      }
      const apiUrl = s?.apiUrl ?? config.browserlessApiUrl;

      def.validateUrl?.(params);

      await reportProgress({ progress: 0, total: 100 });

      const client = createApiClient(
        {
          ...config,
          browserlessToken: token,
          browserlessApiUrl: apiUrl,
        },
        def.cache,
      );

      let result: R;
      try {
        result = await def.run({
          client,
          params,
          log,
          analytics,
          token,
          apiUrl,
          reportProgress,
          sessionId,
        });
      } catch (err) {
        if (err instanceof ProfileNotFoundError) {
          const msg = def.profileNotFoundMessage
            ? def.profileNotFoundMessage(err.profile)
            : defaultProfileMessage(err.profile);
          throw new UserError(msg);
        }
        throw err;
      }

      await reportProgress({ progress: 100, total: 100 });

      if (analytics && def.analyticsProps) {
        analytics.fireToolRequest(token, def.name, {
          api_url: apiUrl,
          ...def.analyticsProps(params, result),
        });
      }

      return { content: def.format(result, params) };
    },
  });
}
