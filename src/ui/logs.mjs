import {
  LogsParamsSchema,
  LogPayloadSchema,
  LogSummarySchema,
  LOG_PAGE_MAX_BYTES,
  LOG_VIEW_MAX_ENTRIES,
  mergeLogEntries,
  logEntryKey,
} from '../lib/log-view-schemas.js';
import { ShowOutputSchema } from '../lib/view-schemas.js';
import { formatTimestamp, formatNumber } from './host.mjs';
import './logs.css';

const node = (tag, text, className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const levels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const fields = [
  ['startTime', 'From (RFC 3339)'],
  ['endTime', 'Until (RFC 3339)'],
  ['endpoint', 'Endpoint'],
  ['outcome', 'Outcome'],
  ['category', 'Failure category'],
  ['reason', 'Failure reason'],
  ['requestId', 'Request ID'],
  ['url', 'Target URL'],
  ['apiKeyId', 'API key ID'],
  ['eventNames', 'Event names (one per line)'],
];
const labels = {
  timestamp: 'Timestamp',
  level: 'Severity',
  endpoint: 'Endpoint',
  eventName: 'Event',
  outcome: 'Outcome',
  status: 'HTTP status',
  category: 'Failure category',
  reason: 'Failure reason',
  durationMs: 'Duration (ms)',
  totalUnits: 'Units',
  region: 'Region',
  message: 'Message',
  url: 'Target URL',
  requestId: 'Request ID',
  sessionId: 'Session ID',
};

function parsePage(raw, data) {
  if (new TextEncoder().encode(JSON.stringify(raw)).length > LOG_PAGE_MAX_BYTES)
    throw new Error('Log page is too large. Reduce entries per page.');
  const payload = LogPayloadSchema.parse(raw);
  const summary = LogSummarySchema.parse(data);
  if (
    summary.entryCount !== payload.entries.length ||
    summary.hasMore !== Boolean(payload.nextCursor)
  )
    throw new Error('Incomplete log response.');
  return payload;
}

export function mountLogs(root, rawPayload, initialView, app, initialHost) {
  let page = parsePage(rawPayload, initialView.data);
  let view = initialView;
  let { rows: entries, bounded } = mergeLogEntries([], page.entries);
  let host = initialHost ?? {},
    pending = false,
    stopped = false,
    expiryTimer,
    lastAction;
  const expanded = new Set();
  const controller = new AbortController();
  root.innerHTML = `<header><span class="logs-icon" aria-hidden="true">≡</span><div><h1>Request logs</h1><p data-role="range"></p></div><button data-role="refresh">Refresh</button></header><details class="logs-filters"><summary>Filters</summary><dl data-role="active-filters"></dl><form><fieldset><div class="logs-filter-grid" data-role="fields"></div><label>Timestamp order<select name="order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label><label>Entries per page<input name="limit" type="number" min="1" max="100" value="50"></label><fieldset class="logs-levels"><legend>Severity</legend></fieldset></fieldset><div class="logs-filter-actions"><button type="button" data-role="apply">Apply filters</button><button type="button" data-role="clear">Clear filters</button></div></form></details><p data-role="status" role="status" aria-live="polite"></p><p data-role="error" role="alert" hidden></p><button data-role="retry" hidden>Retry</button><div class="logs-table-scroll" tabindex="0" role="region" aria-label="Request log entries"><table><thead><tr><th scope="col">Timestamp</th><th scope="col">Severity</th><th scope="col">Endpoint / event</th><th scope="col">Outcome / status</th><th scope="col">Category / reason</th><th scope="col">Duration</th><th scope="col">Units</th><th scope="col">Region</th></tr></thead><tbody></tbody></table></div><p data-role="empty" hidden>No request log entries matched. Widen the time range or remove a filter. The available window depends on your account plan.</p><button data-role="more">Load more</button><footer><span data-role="updated"></span><span>Browserless</span></footer>`;
  const $ = (role) => root.querySelector(`[data-role="${role}"]`);
  const form = root.querySelector('form');
  for (const [selector, role] of [
    ['table', 'table'],
    ['thead,tbody', 'rowgroup'],
    ['tr', 'row'],
    ['th', 'columnheader'],
  ])
    for (const element of root.querySelectorAll(selector))
      element.setAttribute('role', role);
  for (const [key, title] of fields) {
    const label = node('label', title);
    const input = node(key === 'eventNames' ? 'textarea' : 'input');
    input.name = key;
    if (key !== 'eventNames') input.type = 'text';
    input.maxLength = key === 'eventNames' ? 4096 : key === 'url' ? 2048 : 256;
    label.append(input);
    $('fields').append(label);
  }
  for (const level of levels) {
    const label = node('label', level);
    const input = node('input');
    input.type = 'checkbox';
    input.name = 'levels';
    input.value = level;
    label.prepend(input);
    root.querySelector('.logs-levels').append(label);
  }
  function writeForm(filters) {
    for (const [key] of fields)
      form.elements.namedItem(key).value =
        key === 'eventNames'
          ? (filters.eventNames ?? []).join('\n')
          : (filters[key] ?? '');
    form.elements.namedItem('order').value = filters.order ?? 'desc';
    form.elements.namedItem('limit').value = String(filters.limit ?? 50);
    for (const input of form.querySelectorAll('[name="levels"]'))
      input.checked = !filters.levels || filters.levels.includes(input.value);
  }
  function readForm() {
    const filters = {};
    for (const [key] of fields) {
      const value = form.elements.namedItem(key).value.trim();
      if (value)
        filters[key] =
          key === 'eventNames'
            ? value
                .split('\n')
                .map((item) => item.trim())
                .filter(Boolean)
            : value;
    }
    const selected = [...form.querySelectorAll('[name="levels"]:checked')].map(
      (input) => input.value,
    );
    if (selected.length !== levels.length) filters.levels = selected;
    filters.order = form.elements.namedItem('order').value;
    filters.limit = Number(form.elements.namedItem('limit').value);
    return LogsParamsSchema.omit({ cursor: true }).parse(filters);
  }
  function timestamp(value) {
    return (
      formatTimestamp(value, host) ?? (value === null ? 'Unavailable' : value)
    );
  }
  const number = (value, suffix = '') => formatNumber(value, host, suffix);
  function chip(value) {
    const tone = /^(error|fatal|failed)$/i.test(value ?? '')
      ? 'bad'
      : /^(warn|warning|timedout|rejected)$/i.test(value ?? '')
        ? 'warn'
        : /^(succeeded|success)$/i.test(value ?? '')
          ? 'good'
          : '';
    return node('span', value ?? 'Unavailable', `logs-chip ${tone}`);
  }
  function copyButton(value, title) {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    if (
      !navigator.clipboard?.writeText ||
      (policy && !policy.allowsFeature('clipboard-write'))
    )
      return;
    const button = node('button', 'Copy');
    button.type = 'button';
    button.setAttribute('aria-label', `Copy ${title.toLowerCase()}`);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        if (!stopped) button.textContent = 'Copied';
      } catch {
        if (!stopped)
          $('status').textContent =
            'Clipboard access is unavailable. Select the ID and copy it manually.';
      }
    });
    return button;
  }
  function renderRows() {
    const body = root.querySelector('tbody');
    body.replaceChildren();
    const current = new Set(entries.map(logEntryKey));
    for (const key of expanded) if (!current.has(key)) expanded.delete(key);
    for (const entry of entries) {
      const key = logEntryKey(entry);
      const row = node('tr');
      const details = node('tr', undefined, 'logs-detail');
      row.setAttribute('role', 'row');
      details.setAttribute('role', 'row');
      details.hidden = !expanded.has(key);
      const toggle = node(
        'button',
        `${details.hidden ? '›' : '⌄'} ${timestamp(entry.timestamp)}`,
        'logs-row-toggle',
      );
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(!details.hidden));
      toggle.setAttribute(
        'aria-label',
        `Inspect log entry at ${timestamp(entry.timestamp)}`,
      );
      toggle.addEventListener('click', () => {
        details.hidden = !details.hidden;
        toggle.setAttribute('aria-expanded', String(!details.hidden));
        toggle.textContent = `${details.hidden ? '›' : '⌄'} ${timestamp(entry.timestamp)}`;
        if (details.hidden) expanded.delete(key);
        else expanded.add(key);
      });
      const timeCell = node('td');
      timeCell.append(toggle);
      row.append(timeCell);
      const severity = node('td');
      severity.append(chip(entry.level));
      row.append(severity);
      row.append(
        node('td', entry.endpoint ?? entry.eventName ?? 'Unavailable'),
      );
      const outcome = node('td');
      outcome.append(chip(entry.outcome));
      if (entry.status !== null)
        outcome.append(node('small', `HTTP ${entry.status}`));
      row.append(
        outcome,
        node(
          'td',
          [entry.category, entry.reason]
            .filter((value) => value !== null)
            .join(' / ') || 'Unavailable',
        ),
        node('td', number(entry.durationMs, ' ms')),
        node('td', number(entry.totalUnits)),
        node('td', entry.region ?? 'Unavailable'),
      );
      const headers = root.querySelectorAll('th');
      [...row.children].forEach((cell, index) => {
        cell.setAttribute('role', 'cell');
        cell.dataset.label = headers[index].textContent;
      });
      const cell = node('td');
      cell.setAttribute('role', 'cell');
      cell.colSpan = 8;
      const values = node('dl');
      for (const [key, title] of Object.entries(labels)) {
        const group = node('div');
        group.append(node('dt', title));
        const value = node(
          'dd',
          entry[key] === null ? 'Unavailable' : String(entry[key]),
        );
        if (['requestId', 'sessionId'].includes(key) && entry[key] !== null) {
          const copy = copyButton(entry[key], title);
          if (copy) value.append(copy);
        }
        group.append(value);
        values.append(group);
      }
      cell.append(values);
      details.append(cell);
      body.append(row, details);
    }
    $('empty').hidden = entries.length > 0 || stopped;
    root.querySelector('.logs-table-scroll').hidden = !entries.length;
  }
  function render() {
    $('range').textContent =
      `${page.filters.startTime ?? 'Server-defined retention window'} · Until ${page.filters.endTime ?? 'now'} · ${page.filters.order === 'asc' ? 'Oldest' : 'Newest'} first`;
    $('active-filters').replaceChildren();
    for (const [key, value] of Object.entries(page.filters)) {
      const group = node('div');
      group.append(
        node('dt', key),
        node('dd', Array.isArray(value) ? value.join(', ') : String(value)),
      );
      $('active-filters').append(group);
    }
    $('status').textContent =
      `${entries.length} entries loaded${bounded || entries.length >= LOG_VIEW_MAX_ENTRIES ? ' · View limit reached. Narrow filters or refresh.' : ''}`;
    $('updated').textContent = `Snapshot · ${timestamp(view.data.fetchedAt)}`;
    $('more').hidden =
      !page.nextCursor ||
      bounded ||
      entries.length >= LOG_VIEW_MAX_ENTRIES ||
      stopped;
    renderRows();
  }
  function busy(value) {
    pending = value;
    root.setAttribute('aria-busy', String(value));
    form.querySelector('fieldset').disabled = value || stopped;
    for (const button of root.querySelectorAll(
      'form button, header button, [data-role="more"], [data-role="retry"]',
    ))
      button.disabled = value || stopped;
    if (value) $('status').textContent = 'Loading request logs…';
  }
  async function load(mode, filters) {
    if (stopped || pending) return;
    if (Date.parse(view.expiresAt) <= Date.now()) {
      fail(new Error('This log view has expired. Request a new explorer.'));
      return;
    }
    lastAction = { mode, filters };
    const cursor = mode === 'more' ? page.nextCursor : null;
    busy(true);
    try {
      const response = await app.callServerTool({
        name: 'browserless_logs',
        arguments: { ...filters, ...(cursor ? { cursor } : {}) },
      });
      if (stopped) return;
      if (response.isError)
        throw new Error(
          response.content?.find((item) => item.type === 'text')?.text ||
            'Request log update failed.',
        );
      if (!response.structuredContent)
        throw new Error(
          'This update is available as text only. Ask in chat to show these logs as text. For large pages, narrow filters or reduce entries per page; an oversized entry may still require text.',
        );
      const next = ShowOutputSchema.parse(response.structuredContent);
      if (next.kind !== 'request-logs')
        throw new Error('Unexpected log response.');
      const payload = parsePage(response._meta?.payload, next.data);
      const merged = mergeLogEntries(
        mode === 'more' ? entries : [],
        payload.entries,
      );
      entries = merged.rows;
      bounded = merged.bounded;
      page = payload;
      view = next;
      if (mode === 'more' && page.nextCursor === cursor)
        page = { ...page, nextCursor: null };
      if (mode !== 'more') writeForm(page.filters);
      $('error').hidden = true;
      $('retry').hidden = true;
      render();
      scheduleExpiry();
    } catch (error) {
      if (stopped) return;
      if (
        /\b(?:401|403)\b|unauthori[sz]ed|forbidden|access revoked|view is unavailable|not available for this plan/i.test(
          error.message ?? '',
        )
      ) {
        fail(error);
        return;
      }
      $('error').textContent =
        error.message || 'Unable to update request logs.';
      $('error').hidden = false;
      $('retry').hidden = false;
      $('status').textContent =
        'Update failed · Showing the last successful result';
    } finally {
      if (!stopped) busy(false);
    }
  }
  function applyFilters(event) {
    event.preventDefault();
    try {
      void load('replace', readForm());
    } catch {
      $('error').textContent = 'Check the filter values and page size (1–100).';
      $('error').hidden = false;
      $('retry').hidden = true;
    }
  }
  // Some hosts forbid native form submission even when JavaScript cancels it.
  $('apply').addEventListener('click', applyFilters, {
    signal: controller.signal,
  });
  form.addEventListener('submit', applyFilters, { signal: controller.signal });
  form.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT')
        applyFilters(event);
    },
    { signal: controller.signal },
  );
  $('refresh').addEventListener(
    'click',
    () => void load('replace', page.filters),
    { signal: controller.signal },
  );
  $('more').addEventListener('click', () => void load('more', page.filters), {
    signal: controller.signal,
  });
  $('retry').addEventListener(
    'click',
    () => {
      if (lastAction) void load(lastAction.mode, lastAction.filters);
    },
    { signal: controller.signal },
  );
  $('clear').addEventListener(
    'click',
    () => {
      writeForm({});
      void load('replace', {});
    },
    { signal: controller.signal },
  );
  function fail(error) {
    stopped = true;
    clearTimeout(expiryTimer);
    controller.abort();
    entries = [];
    page = { ...page, entries: [], nextCursor: null };
    expanded.clear();
    render();
    busy(false);
    $('status').textContent = /cancel/i.test(error.message ?? '')
      ? 'Cancelled'
      : /expir/i.test(error.message ?? '')
        ? 'Expired'
        : 'Unavailable';
    $('error').textContent =
      error.message || 'The log explorer is unavailable.';
    $('error').hidden = false;
    $('retry').hidden = true;
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const remaining = Date.parse(view.expiresAt) - Date.now();
    const expire = () =>
      fail(new Error('This log view has expired. Request a new explorer.'));
    if (remaining <= 0) expire();
    else expiryTimer = setTimeout(expire, remaining);
  }
  writeForm(page.filters);
  render();
  scheduleExpiry();
  return {
    fail,
    updateHost(context) {
      if (stopped) return;
      host = { ...host, ...context };
      render();
    },
    dispose() {
      stopped = true;
      clearTimeout(expiryTimer);
      controller.abort();
      root.replaceChildren();
    },
  };
}
