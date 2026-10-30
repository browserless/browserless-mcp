import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, assertHttpScheme } from '../lib/define-tool.js';
import { profileField } from './schemas.js';
import {
  isCompliant,
  COMPLIANT_PERFORMANCE_DESCRIPTION,
} from './compliance.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { downloadOwner, storeDownload } from '../lib/download-store.js';
import { describeReadyDownload } from './agent.js';
import type {
  McpConfig,
  PerformanceParams,
  PerformanceResponse,
} from '../@types/types.js';

export const LighthouseCategorySchema = z.enum([
  'accessibility',
  'best-practices',
  'performance',
  'pwa',
  'seo',
]);

export const LighthouseDeviceSchema = z.enum(['mobile', 'desktop']);

export const PerformanceParamsSchema = z.object({
  url: z.url().describe('The URL to audit (must be http or https)'),
  categories: z
    .array(LighthouseCategorySchema)
    .optional()
    .describe(
      'Lighthouse categories to audit: "accessibility", "best-practices", ' +
        '"performance", "pwa", "seo". Omit for all categories.',
    ),
  device: LighthouseDeviceSchema.optional().describe(
    'Device to emulate during the audit: "mobile" or "desktop". Applies ' +
      "Lighthouse's matching form factor, screen size, network/CPU throttling " +
      'and user agent. Omit for the Lighthouse default (mobile).',
  ),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Custom Lighthouse config object, sent as the /performance "config" ' +
        'field. Defaults to { extends: "lighthouse:default" }. "categories" ' +
        'and "device" override the matching keys in config.settings. ' +
        'See https://github.com/GoogleChrome/lighthouse/blob/main/docs/configuration.md',
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

// Excludes `profile` (auth-session hydration) — no authentication-profile
// capability on the compliant surface (parity with agent/export/search).
const CompliantPerformanceParamsSchema = PerformanceParamsSchema.pick({
  url: true,
  categories: true,
  device: true,
  timeout: true,
}).strict();

export function registerPerformanceTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  const compliant = isCompliant(config);
  defineTool<PerformanceParams, PerformanceResponse>(
    server,
    config,
    analytics,
    {
      name: 'browserless_performance',
      description: compliant
        ? COMPLIANT_PERFORMANCE_DESCRIPTION
        : 'Run a Lighthouse performance audit on any URL via the Browserless /performance API. ' +
          'Returns scores and metrics for accessibility, best practices, performance, PWA, and SEO. ' +
          'Optionally filter by category, emulate a mobile or desktop device, ' +
          'supply a custom Lighthouse config, or supply performance budgets. ' +
          'Returns category scores and available Lighthouse lab metrics inline: ' +
          'FCP, LCP, TBT, CLS, Speed Index, initial server response time, and total transfer size. ' +
          'Use these metrics to answer page-speed questions without writing timing scripts. ' +
          'INP is not measured by this navigation audit; TBT is a responsiveness proxy. ' +
          'Saves the full JSON report outside the conversation. ' +
          'Use the local path (stdio) or download URL (HTTP) to inspect only the audits you need. ' +
          'Note: audits can take 30s–120s depending on the site.',
      parameters: compliant
        ? (CompliantPerformanceParamsSchema as z.ZodType<PerformanceParams>)
        : PerformanceParamsSchema,
      annotations: {
        title: 'Browserless Lighthouse Performance Audit',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      validateUrl: (p) => assertHttpScheme(p.url),
      profileNotFoundMessage: (profile) =>
        `Profile "${profile}" was not found for the configured API ` +
        `token. Create the profile with Browserless.saveProfile in a ` +
        `live session first, or omit the profile parameter to audit ` +
        `the page anonymously.`,
      run: async ({ client, params, log }) => {
        if (
          compliant &&
          (params.config !== undefined || params.budgets !== undefined)
        ) {
          throw new UserError(
            'config and budgets are not available on this endpoint.',
          );
        }
        if (compliant && params.profile !== undefined) {
          throw new UserError(
            'Authentication profiles are not available on this endpoint.',
          );
        }
        const response = await client.performance({
          url: params.url,
          categories: params.categories,
          device: params.device,
          config: params.config,
          budgets: params.budgets,
          timeout: params.timeout,
          profile: params.profile,
        });
        log.debug(
          `Performance response: type=${response.type}, ` +
            `dataKeys=${Object.keys(response.data ?? {}).length}`,
        );
        return response;
      },
      analyticsProps: (params) => ({
        url: params.url,
        categories: (params.categories ?? []).join(','),
        device: params.device ?? '',
        custom_config: !!params.config,
        profile_used: !!params.profile,
      }),
      format: async (response, params, { token, sessionId }) => {
        const blocks: Content[] = [];
        const data = response.data ?? {};
        const categories = (data.categories ?? {}) as Record<
          string,
          { title?: string; score?: number | null }
        >;
        const categoryEntries = Object.entries(categories);
        if (categoryEntries.length > 0) {
          const summary = categoryEntries
            .map(([id, cat]) => {
              const score =
                cat.score != null
                  ? `${Math.round(cat.score * 100)}/100`
                  : 'N/A';
              return `- ${cat.title ?? id}: ${score}`;
            })
            .join('\n');
          blocks.push({
            type: 'text' as const,
            text: `## Lighthouse Scores\n${summary}`,
          });
        }
        const audits = (data.audits ?? {}) as Record<
          string,
          {
            displayValue?: string;
            numericValue?: number;
            scoreDisplayMode?: string;
          }
        >;
        const metrics = [
          ['first-contentful-paint', 'FCP', 'ms'],
          ['largest-contentful-paint', 'LCP', 'ms'],
          ['total-blocking-time', 'TBT', 'ms'],
          ['cumulative-layout-shift', 'CLS', ''],
          ['speed-index', 'Speed Index', 'ms'],
          ['server-response-time', 'Initial server response time', 'ms'],
          ['total-byte-weight', 'Total transfer size', 'bytes'],
        ];
        if (categories.performance || metrics.some(([id]) => audits[id])) {
          const summary = metrics.map(([id, label, unit]) => {
            const audit = audits[id];
            let value = 'Unavailable';
            if (
              audit &&
              !['error', 'notApplicable'].includes(audit.scoreDisplayMode ?? '')
            ) {
              if (audit.displayValue) {
                value = audit.displayValue;
              } else if (
                typeof audit.numericValue === 'number' &&
                Number.isFinite(audit.numericValue)
              ) {
                value = `${audit.numericValue}${unit ? ` ${unit}` : ''}`;
              }
            }
            return `- ${label}: ${value}`;
          });
          blocks.push({
            type: 'text',
            text:
              `## Lighthouse Lab Metrics\n${summary.join('\n')}\n` +
              'INP is not measured by this navigation audit; TBT is a responsiveness proxy.',
          });
        }
        if (!compliant) {
          const record = await storeDownload(
            'lighthouse-report.json',
            'application/json',
            Buffer.from(JSON.stringify(data, null, 2)),
            downloadOwner(token),
            sessionId,
          );
          blocks.push({
            type: 'text' as const,
            text:
              'Full Lighthouse report saved outside the conversation:\n' +
              describeReadyDownload(record, {
                transport: config.transport,
                mcpBaseUrl: config.mcpBaseUrl,
                token,
              }) +
              '\nFiles expire after 15 minutes or when the MCP session ends; save a copy if needed. ' +
              'For HTTP, download to disk first using the save command above. ' +
              'Inspect only the fields needed for your task with jq, for example:\n' +
              'jq \'.audits["first-contentful-paint"] | {score, displayValue, numericValue}\' <saved-report-path>\n' +
              'Do not read or paste the entire JSON report into the conversation.',
          });
        }
        const meta = [
          '---',
          `URL: ${params.url}`,
          ...(!compliant
            ? [
                `Lighthouse Version: ${(data.lighthouseVersion as string) ?? 'unknown'}`,
              ]
            : []),
        ];
        if (params.categories) {
          meta.push(`Categories: ${params.categories.join(', ')}`);
        }
        if (params.device) {
          meta.push(`Device: ${params.device}`);
        }
        meta.push('---');
        blocks.push({ type: 'text' as const, text: meta.join('\n') });
        return blocks;
      },
    },
  );
}
