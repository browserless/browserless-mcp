import { z } from 'zod';
import type { PerformanceParams } from '../@types/types.js';

export const PERFORMANCE_URI = 'ui://browserless/performance/v3.html';
const Score = z.number().int().min(0).max(100).nullable();
export const PerformanceViewSchema = z.object({
  kind: z.literal('performance'),
  url: z.string().max(2048),
  device: z.enum(['mobile', 'desktop']).nullable(),
  version: z.string().max(64).nullable(),
  categories: z
    .array(
      z.object({
        id: z.string().max(64),
        title: z.string().max(128),
        score: Score,
        failedCount: z.number().int().nonnegative(),
        audits: z.array(
          z.object({
            id: z.string().max(128),
            title: z.string().max(256),
            description: z.string().max(2000),
            displayValue: z.string().max(256).nullable(),
            savings: z.string().max(256).nullable(),
          }),
        ),
      }),
    )
    .max(5),
  metrics: z
    .array(
      z.object({
        id: z.string().max(64),
        title: z.string().max(128),
        value: z.string().max(256).nullable(),
        score: Score,
      }),
    )
    .max(5),
});

export type PerformanceView = z.infer<typeof PerformanceViewSchema>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : '';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const score = (value: unknown): number | null =>
  finite(value) && value >= 0 && value <= 1 ? Math.round(value * 100) : null;
const ignoredModes = new Set([
  'error',
  'manual',
  'informative',
  'notApplicable',
]);
const metrics = [
  ['largest-contentful-paint', 'Largest contentful paint', 'ms'],
  ['total-blocking-time', 'Total blocking time', 'ms'],
  ['cumulative-layout-shift', 'Cumulative layout shift', ''],
  ['first-contentful-paint', 'First contentful paint', 'ms'],
  ['speed-index', 'Speed Index', 'ms'],
] as const;

/** Extract only report fields used by the scorecard; never forward raw audit details. */
export function summarizePerformance(
  data: Record<string, unknown>,
  params: PerformanceParams,
): PerformanceView {
  const audits = object(data.audits);
  const categories = object(data.categories);
  const categoryTitles = {
    performance: 'Performance',
    accessibility: 'Accessibility',
    'best-practices': 'Best practices',
    seo: 'SEO',
    pwa: 'PWA',
  } as const;
  const result = Object.entries(categoryTitles)
    .filter(
      ([id]) =>
        categories[id] &&
        (!params.categories ||
          params.categories.includes(id as keyof typeof categoryTitles)),
    )
    .map(([id, title]) => {
      const category = object(categories[id]);
      const refs = Array.isArray(category.auditRefs) ? category.auditRefs : [];
      const seen = new Set<string>();
      const failing = refs.flatMap((ref) => {
        const auditId = object(ref).id;
        if (typeof auditId !== 'string' || seen.has(auditId)) return [];
        seen.add(auditId);
        const audit = object(audits[auditId]);
        if (
          !finite(audit.score) ||
          audit.score < 0 ||
          audit.score >= 1 ||
          ignoredModes.has(String(audit.scoreDisplayMode)) ||
          typeof audit.title !== 'string'
        )
          return [];
        const details = object(audit.details);
        const lcpSavings = object(audit.metricSavings).LCP;
        const milliseconds = finite(details.overallSavingsMs)
          ? Math.max(0, details.overallSavingsMs)
          : finite(lcpSavings)
            ? Math.max(0, lcpSavings)
            : 0;
        const bytes = finite(details.overallSavingsBytes)
          ? Math.max(0, details.overallSavingsBytes)
          : 0;
        const savings = [
          milliseconds
            ? `Est. ${Math.round(milliseconds).toLocaleString('en-US')} ms${!finite(details.overallSavingsMs) ? ' LCP' : ''} savings`
            : '',
          bytes
            ? `Est. ${(bytes < 1024 ? bytes : bytes / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${bytes < 1024 ? 'bytes' : 'KiB'} savings`
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const description =
          typeof audit.description === 'string'
            ? audit.description.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            : '';
        return [
          {
            milliseconds,
            bytes,
            summary: {
              id: auditId.slice(0, 128),
              title: text(audit.title, 256),
              description: text(description, 2000),
              displayValue: text(audit.displayValue, 256) || null,
              savings: savings || null,
            },
          },
        ];
      });
      failing.sort(
        (a, b) => b.milliseconds - a.milliseconds || b.bytes - a.bytes,
      );
      return {
        id,
        title: text(category.title, 128) || title,
        score: score(category.score),
        failedCount: failing.length,
        audits: failing.map((audit) => audit.summary),
      };
    });
  const settings = object(data.configSettings);
  const device = settings.formFactor ?? params.device;
  return PerformanceViewSchema.parse({
    kind: 'performance',
    url:
      text(data.finalDisplayedUrl, 2048) ||
      text(data.finalUrl, 2048) ||
      params.url.slice(0, 2048),
    device: device === 'mobile' || device === 'desktop' ? device : null,
    version: text(data.lighthouseVersion, 64) || null,
    categories: result,
    metrics: result.some((category) => category.id === 'performance')
      ? metrics.map(([id, title, unit]) => {
          const audit = object(audits[id]);
          const unavailable = ignoredModes.has(String(audit.scoreDisplayMode));
          const value = unavailable
            ? null
            : text(audit.displayValue, 256) ||
              (finite(audit.numericValue) && audit.numericValue >= 0
                ? unit === 'ms' && audit.numericValue >= 1000
                  ? `${(audit.numericValue / 1000).toFixed(1)} s`
                  : `${audit.numericValue}${unit ? ` ${unit}` : ''}`
                : null);
          return {
            id,
            title,
            value,
            score: value === null ? null : score(audit.score),
          };
        })
      : [],
  });
}
