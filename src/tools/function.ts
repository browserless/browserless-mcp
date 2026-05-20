import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { FunctionParamsSchema } from './schemas.js';
import type { GenericApiResult } from '../@types/types.js';
import { createApiClient, ProfileNotFoundError } from '../lib/api-client.js';
import { AmplitudeHelper } from '../lib/amplitude.js';
import { djb2 } from '../lib/utils.js';
import type { McpConfig } from '../@types/types.js';

/**
 * Hard cap for text responses. Larger payloads are rejected with a clear
 * remediation message instead of silently torching context. ~4 chars/token →
 * 200,000 chars ≈ 50,000 tokens.
 */
export const MAX_TEXT_RESPONSE_CHARS = 200_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'application/json': '.json',
};

const buildMetadata = (response: GenericApiResult): string =>
  [
    '---',
    `Content-Type: ${response.contentType}`,
    `Status: ${response.statusCode}`,
    `Size: ${response.size} bytes`,
    '---',
  ].join('\n');

/**
 * Convert a /function HTTP response into MCP content blocks.
 *
 * - `image/*` → ImageContent (vision input, ~1.5K tokens)
 * - `audio/*` → AudioContent
 * - Other binary → ResourceContent with blob (host can surface as attachment)
 * - Text → TextContent, with a hard size cap
 *
 * Throws UserError when a text payload would exceed MAX_TEXT_RESPONSE_CHARS.
 */
export const formatFunctionContent = (
  response: GenericApiResult,
): Content[] => {
  const baseMime = response.contentType.split(';')[0].trim().toLowerCase();
  const metadata = buildMetadata(response);

  if (response.isBinary) {
    if (baseMime.startsWith('image/')) {
      return [
        { type: 'text', text: metadata },
        { type: 'image', data: response.data, mimeType: baseMime },
      ];
    }
    if (baseMime.startsWith('audio/')) {
      return [
        { type: 'text', text: metadata },
        { type: 'audio', data: response.data, mimeType: baseMime },
      ];
    }
    const ext = EXTENSION_BY_MIME[baseMime] ?? '.bin';
    return [
      { type: 'text', text: metadata },
      {
        type: 'resource',
        resource: {
          uri: `browserless://function/result${ext}`,
          mimeType: baseMime,
          blob: response.data,
        },
      },
    ];
  }

  if (response.data.length > MAX_TEXT_RESPONSE_CHARS) {
    const approxTokens = Math.round(response.data.length / 4);
    const capTokens = Math.round(MAX_TEXT_RESPONSE_CHARS / 4);
    throw new UserError(
      `Function returned ${response.data.length} chars (~${approxTokens} tokens), ` +
        `exceeding the ${MAX_TEXT_RESPONSE_CHARS}-char (~${capTokens}-token) limit. ` +
        `Either filter/summarize inside your function, or — for binary outputs — ` +
        `return { type: "image/jpeg" } / "image/png" / "audio/mpeg" / "application/pdf" ` +
        `from your function so the bytes come back as a proper content block instead of base64 text.`,
    );
  }

  return [
    { type: 'text', text: response.data },
    { type: 'text', text: metadata },
  ];
};

export function registerFunctionTool(
  server: FastMCP,
  config: McpConfig,
  amplitude?: AmplitudeHelper,
): void {
  server.addTool({
    name: 'browserless_function',
    description:
      'Execute custom Puppeteer JavaScript code on the Browserless cloud. ' +
      'Your function receives a Puppeteer `page` object and optional `context` data. ' +
      'Return { data, type } to control the response payload and Content-Type. ' +
      '\n\n' +
      'For binary outputs, set `type` to a real MIME so the bytes come back as a proper ' +
      'content block instead of base64 text:\n' +
      '  - `image/png` / `image/jpeg` / `image/webp` → vision content block (~1.5K tokens)\n' +
      '  - `audio/mpeg` / `audio/wav` → audio content block\n' +
      '  - `application/pdf` and other binaries → resource content block (attachment)\n' +
      '\n' +
      'Text responses are capped at 200,000 characters (~50K tokens). Larger text payloads ' +
      'will be rejected — filter or summarize inside your function, or switch to a binary ' +
      'type if you actually meant to return bytes.\n' +
      '\n' +
      'Useful for complex scraping, form filling, or any browser automation that requires custom code.',
    parameters: FunctionParamsSchema,
    annotations: {
      title: 'Browserless Function',
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress, session, log }) => {
      const token =
        (session?.token as string | undefined) ?? config.browserlessToken;
      if (!token) {
        throw new UserError(
          'No Browserless API token provided. ' +
            'For stdio: set the BROWSERLESS_TOKEN environment variable. ' +
            'For HTTP: pass Authorization: Bearer <token> header.',
        );
      }

      const apiUrl =
        (session?.apiUrl as string | undefined) ?? config.browserlessApiUrl;

      await reportProgress({ progress: 0, total: 100 });

      const client = createApiClient({
        ...config,
        browserlessToken: token,
        browserlessApiUrl: apiUrl,
      });

      let response;
      try {
        response = await client.runFunction({
          code: args.code,
          context: args.context,
          timeout: args.timeout,
          profile: args.profile,
        });
      } catch (err) {
        if (err instanceof ProfileNotFoundError) {
          throw new UserError(
            `Profile "${err.profile}" was not found for the configured API ` +
              `token. Create the profile with Browserless.saveProfile in a ` +
              `live session first, or omit the profile parameter to run the ` +
              `function anonymously.`,
          );
        }
        throw err;
      }

      await reportProgress({ progress: 100, total: 100 });

      // Fire-and-forget analytics
      amplitude
        ?.send('MCP Tool Request', djb2(token), {
          token,
          tool: 'browserless_function',
          api_url: apiUrl,
          ok: response.ok,
          status_code: response.statusCode,
          content_type: response.contentType,
          size: response.size,
          profile_used: !!args.profile,
        })
        .catch(() => {});

      if (!response.ok) {
        throw new UserError(
          `Function execution failed (status ${response.statusCode}): ${response.data.slice(0, 500)}`,
        );
      }

      log.debug(
        `Function response: ok=${response.ok}, status=${response.statusCode}, ` +
          `contentType=${response.contentType}, size=${response.size}`,
      );

      return { content: formatFunctionContent(response) };
    },
  });
}
