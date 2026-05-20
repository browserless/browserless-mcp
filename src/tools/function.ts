import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, profileField } from '../lib/define-tool.js';
import { AmplitudeHelper } from '../lib/amplitude.js';
import type {
  FunctionParams,
  GenericApiResult,
  McpConfig,
} from '../@types/types.js';

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
  defineTool<FunctionParams, GenericApiResult>(server, config, amplitude, {
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
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to run the ` +
      `function anonymously.`,
    run: async ({ client, params, log }) => {
      const response = await client.runFunction({
        code: params.code,
        context: params.context,
        timeout: params.timeout,
        profile: params.profile,
      });
      log.debug(
        `Function response: ok=${response.ok}, status=${response.statusCode}, ` +
          `contentType=${response.contentType}, size=${response.size}`,
      );
      return response;
    },
    analyticsProps: (params, result) => ({
      ok: result.ok,
      status_code: result.statusCode,
      content_type: result.contentType,
      size: result.size,
      profile_used: !!params.profile,
    }),
    format: (response) => {
      if (!response.ok) {
        throw new UserError(
          `Function execution failed (status ${response.statusCode}): ${response.data.slice(0, 500)}`,
        );
      }
      return formatFunctionContent(response);
    },
  });
}
