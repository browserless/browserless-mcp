import { PerformanceViewSchema } from '../lib/performance-summary.js';
import './performance.css';

const rating = (score) =>
  score === null
    ? 'Unavailable'
    : score >= 90
      ? 'Good'
      : score >= 50
        ? 'Needs improvement'
        : 'Poor';
const tone = (score) =>
  score === null
    ? 'unavailable'
    : score >= 90
      ? 'good'
      : score >= 50
        ? 'warn'
        : 'poor';
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function mountPerformance(root, rawPayload) {
  const report = PerformanceViewSchema.parse(rawPayload);
  const controller = new AbortController();
  root.innerHTML = `<header class="perf-heading"><span class="perf-brand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19a10 10 0 1 1 16 0M12 12l5-5M4 12h2m12 0h2M12 2v2"/><circle cx="12" cy="12" r="1.5"/></svg></span><div><h1>Performance report</h1><p data-role="website"></p></div><span class="perf-device" data-role="device"></span></header><div class="perf-scores" role="group" aria-label="Select audit category"></div><section class="perf-lab" aria-label="Lighthouse lab metrics"><div class="perf-section-heading"><h2>Lab metrics</h2><span data-role="lab-device"></span></div><dl class="perf-metrics"></dl><p class="perf-lab-note">Single lab run. INP is not measured; TBT is a responsiveness proxy.</p></section><details class="perf-findings" aria-label="Failing audits"><summary class="perf-findings-heading"><span data-role="findings-title">Failing audits</span><span data-role="findings-count"></span></summary><div class="perf-findings-body"></div></details><footer><span data-role="version"></span><span>Browserless</span></footer>`;
  const $ = (selector) => root.querySelector(selector);
  let website = report.url;
  try {
    const url = new URL(report.url);
    website = url.hostname + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    /* Show the supplied label as text if the report URL is malformed. */
  }
  $('[data-role="website"]').textContent = website;
  $('[data-role="device"]').textContent =
    report.device === 'mobile' ? 'Mobile' : 'Desktop';
  $('[data-role="device"]').hidden = report.device === null;
  $('[data-role="lab-device"]').textContent = report.device
    ? `${report.device === 'mobile' ? 'Mobile' : 'Desktop'} · Lab data`
    : 'Lab data';
  $('[data-role="version"]').textContent =
    `Lighthouse${report.version ? ` ${report.version}` : ''} · Single lab run`;
  $('.perf-lab').hidden = !report.metrics.length;
  for (const metric of report.metrics) {
    const row = node('div', 'perf-metric');
    row.append(node('dt', '', metric.title));
    const value = node('dd', '');
    const marker = node('span', `perf-marker ${tone(metric.score)}`);
    marker.setAttribute('aria-hidden', 'true');
    value.append(
      marker,
      document.createTextNode(metric.value ?? 'Unavailable'),
    );
    row.append(
      value,
      node(
        'small',
        '',
        metric.value === null
          ? 'Not measured'
          : metric.score === null
            ? 'Unrated'
            : rating(metric.score),
      ),
    );
    $('.perf-metrics').append(row);
  }
  const buttons = new Map();
  function select(category) {
    for (const [id, button] of buttons)
      button.setAttribute('aria-pressed', String(id === category.id));
    $('.perf-findings').open = false;
    const findings = $('.perf-findings-body');
    findings.replaceChildren();
    $('[data-role="findings-title"]').textContent =
      `${category.title} · Failing audits`;
    $('[data-role="findings-count"]').textContent = String(
      category.audits.length,
    );
    if (!category.audits.length) {
      findings.append(
        node(
          'p',
          'perf-empty',
          category.score === null
            ? 'Lighthouse did not return a score for this category.'
            : 'No failing audit details were returned for this category.',
        ),
      );
      return;
    }
    for (const audit of category.audits) {
      const details = node('details', 'perf-audit');
      const summary = node('summary', '');
      summary.append(node('span', 'perf-audit-title', audit.title));
      if (audit.savings || audit.displayValue)
        summary.append(
          node('span', 'perf-saving', audit.savings ?? audit.displayValue),
        );
      const description = node('div', 'perf-audit-detail');
      if (audit.description)
        description.append(node('p', '', audit.description));
      if (audit.displayValue && audit.savings)
        description.append(node('p', '', audit.displayValue));
      if (!description.childNodes.length)
        description.append(
          node('p', '', 'No further details were returned for this audit.'),
        );
      details.append(summary, description);
      findings.append(details);
    }
  }
  for (const category of report.categories) {
    const button = node('button', 'perf-score');
    button.type = 'button';
    button.dataset.category = category.id;
    button.setAttribute(
      'aria-label',
      `${category.title}: ${category.score === null ? 'unavailable' : `${category.score} out of 100, ${rating(category.score)}`}`,
    );
    const gauge = node('span', `perf-gauge ${tone(category.score)}`);
    gauge.setAttribute('aria-hidden', 'true');
    // Only the validated numeric score enters SVG markup. Report text uses textContent.
    gauge.innerHTML = `<svg viewBox="0 0 80 80" fill="none"><circle class="perf-track" cx="40" cy="40" r="34" stroke-width="5"/><circle class="perf-arc" cx="40" cy="40" r="34" stroke-width="5" pathLength="100" stroke-dasharray="${category.score ?? 0} 100"/></svg>`;
    gauge.append(
      node(
        'span',
        'perf-number',
        category.score === null ? '—' : String(category.score),
      ),
    );
    button.append(
      gauge,
      node('span', 'perf-category', category.title),
      node('span', 'perf-rating', rating(category.score)),
    );
    button.addEventListener('click', () => select(category), {
      signal: controller.signal,
    });
    buttons.set(category.id, button);
    $('.perf-scores').append(button);
  }
  if (report.categories.length)
    select(
      report.categories.find((category) => category.id === 'performance') ??
        report.categories[0],
    );
  else
    $('.perf-findings-body').append(
      node(
        'p',
        'perf-empty',
        'No category results were returned for this audit.',
      ),
    );
  return {
    dispose() {
      controller.abort();
      root.replaceChildren();
    },
  };
}
