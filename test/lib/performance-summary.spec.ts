import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import {
  PerformanceViewSchema,
  summarizePerformance,
} from '../../src/lib/performance-summary.js';

// Recorded with Lighthouse against a local synthetic page; URLs are sanitized.
const recorded = JSON.parse(
  readFileSync('test/fixtures/lighthouse-performance.json', 'utf8'),
);
const params = { url: 'https://example.test/' };

describe('Lighthouse scorecard summary', () => {
  it('extracts category-owned failures and five metrics from a recorded Lighthouse response', () => {
    const report = summarizePerformance(recorded, params);
    expect(PerformanceViewSchema.safeParse(report).success).to.equal(true);
    expect(report.categories.map((category) => category.id)).to.deep.equal([
      'performance',
      'accessibility',
      'best-practices',
      'seo',
    ]);
    expect(report.metrics).to.have.length(5);
    const accessibility = report.categories.find(
      (category) => category.id === 'accessibility',
    )!;
    expect(accessibility.audits.map((audit) => audit.id)).to.include(
      'color-contrast',
    );
    expect(
      accessibility.audits.every((audit) =>
        recorded.categories.accessibility.auditRefs.some(
          (ref: { id: string }) => ref.id === audit.id,
        ),
      ),
    ).to.equal(true);
    expect(JSON.stringify(report)).not.to.include('auditRefs');
    expect(JSON.stringify(report)).not.to.include('numericValue');
    expect(report.url).to.equal(recorded.finalUrl);
    expect(report.device).to.equal('mobile');
  });

  it('preserves null and zero scores and hides missing or unrequested categories', () => {
    const report = summarizePerformance(
      {
        categories: {
          performance: { score: 0 },
          accessibility: { score: null },
          seo: { score: 0.9 },
        },
        audits: { 'cumulative-layout-shift': { numericValue: 0, score: 1 } },
      },
      params,
    );
    expect(report.categories.map((category) => category.score)).to.deep.equal([
      0,
      null,
      90,
    ]);
    expect(
      report.metrics.find((metric) => metric.id === 'cumulative-layout-shift')!
        .value,
    ).to.equal('0');
    expect(
      report.metrics.find((metric) => metric.id === 'largest-contentful-paint')!
        .value,
    ).to.equal(null);
    const seo = summarizePerformance(recorded, {
      ...params,
      categories: ['seo'],
    });
    expect(seo.categories.map((category) => category.id)).to.deep.equal([
      'seo',
    ]);
    expect(seo.metrics).to.deep.equal([]);
    expect(summarizePerformance({}, params).categories).to.deep.equal([]);
    expect(
      summarizePerformance({ categories: { pwa: { score: 1 } } }, params)
        .categories[0].id,
    ).to.equal('pwa');
  });

  it('retains and ranks every failing audit, ignores unscored modes, and does not call numeric values savings', () => {
    const audits = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `audit-${index}`,
        {
          title: `Failure ${index}`,
          description: 'x'.repeat(3000),
          score: 0,
          details: {
            overallSavingsMs: index * 100,
            overallSavingsBytes: index * 1024,
          },
        },
      ]),
    );
    const report = summarizePerformance(
      {
        categories: {
          performance: {
            score: 0.5,
            auditRefs: [
              ...Object.keys(audits).map((id) => ({ id })),
              { id: 'audit-1' },
              { id: 'resource-value' },
              { id: 'unscored' },
              { id: 'passed' },
              { id: 'missing' },
            ],
          },
        },
        audits: {
          ...audits,
          'resource-value': {
            title: 'Resource size',
            score: 0,
            numericValue: 900000,
          },
          unscored: {
            title: 'Informational',
            score: 0,
            scoreDisplayMode: 'informative',
          },
          passed: { title: 'Passed', score: 1 },
        },
      },
      params,
    );
    const category = report.categories[0];
    expect(category.failedCount).to.equal(9);
    expect(category.audits).to.have.length(category.failedCount);
    expect(category.audits.map((audit) => audit.id)).to.have.members([
      ...Object.keys(audits),
      'resource-value',
    ]);
    expect(category.audits[0]).to.include({
      id: 'audit-7',
      savings: 'Est. 700 ms savings · Est. 7 KiB savings',
    });
    expect(category.audits[0].description).to.have.length(2000);
    const modern = summarizePerformance(
      {
        categories: { performance: { auditRefs: [{ id: 'modern' }] } },
        audits: {
          modern: {
            title: 'Modern insight',
            score: 0,
            metricSavings: { LCP: 1200, FCP: 3000 },
          },
        },
      },
      params,
    );
    expect(modern.categories[0].audits[0].savings).to.equal(
      'Est. 1,200 ms LCP savings',
    );
    const numeric = summarizePerformance(
      {
        categories: { seo: { auditRefs: [{ id: 'size' }] } },
        audits: {
          size: { title: 'Size', score: 0, numericValue: 900000 },
        },
      },
      params,
    );
    expect(numeric.categories[0].audits[0].savings).to.equal(null);
    const small = summarizePerformance(
      {
        categories: { seo: { auditRefs: [{ id: 'small' }] } },
        audits: {
          small: {
            title: 'Small resource',
            score: 0,
            details: { overallSavingsBytes: 256 },
          },
        },
      },
      params,
    );
    expect(small.categories[0].audits[0].savings).to.equal(
      'Est. 256 bytes savings',
    );
  });

  it('marks errored metrics unavailable and never invents a device', () => {
    const report = summarizePerformance(
      {
        categories: { performance: { score: Infinity } },
        audits: {
          'total-blocking-time': {
            numericValue: 0,
            displayValue: '0 ms',
            scoreDisplayMode: 'error',
            score: 1,
          },
          'speed-index': { numericValue: 1200, score: 0.49 },
        },
      },
      params,
    );
    expect(report.categories[0].score).to.equal(null);
    expect(report.device).to.equal(null);
    expect(
      report.metrics.find((metric) => metric.id === 'total-blocking-time'),
    ).to.include({ value: null, score: null });
    expect(
      report.metrics.find((metric) => metric.id === 'speed-index'),
    ).to.include({ value: '1.2 s', score: 49 });
  });
});
