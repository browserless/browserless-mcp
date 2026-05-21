import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import {
  defineTool,
  profileField,
  validateHttpUrl,
} from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
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

export function registerPerformanceTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<PerformanceParams, PerformanceResponse>(
    server,
    config,
    analytics,
    {
      name: 'browserless_performance',
      description:
        'Run a Lighthouse performance audit on any URL via the Browserless /performance API. ' +
        'Returns scores and metrics for accessibility, best practices, performance, PWA, and SEO. ' +
        'Optionally filter by category or supply performance budgets. ' +
        'Note: audits can take 30s–120s depending on the site.',
      parameters: PerformanceParamsSchema,
      annotations: {
        title: 'Browserless Lighthouse Performance Audit',
        readOnlyHint: true,
        openWorldHint: true,
      },
      validateUrl: (p) => validateHttpUrl(p.url),
      profileNotFoundMessage: (profile) =>
        `Profile "${profile}" was not found for the configured API ` +
        `token. Create the profile with Browserless.saveProfile in a ` +
        `live session first, or omit the profile parameter to audit ` +
        `the page anonymously.`,
      run: async ({ client, params, log }) => {
        const response = await client.performance({
          url: params.url,
          categories: params.categories,
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
        profile_used: !!params.profile,
      }),
      format: (response, params) => {
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
        blocks.push({
          type: 'text' as const,
          text: JSON.stringify(data, null, 2),
        });
        const meta = [
          '---',
          `URL: ${params.url}`,
          `Lighthouse Version: ${(data.lighthouseVersion as string) ?? 'unknown'}`,
        ];
        if (params.categories) {
          meta.push(`Categories: ${params.categories.join(', ')}`);
        }
        meta.push('---');
        blocks.push({ type: 'text' as const, text: meta.join('\n') });
        return blocks;
      },
    },
  );
}
