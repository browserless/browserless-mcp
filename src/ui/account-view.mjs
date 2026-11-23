import { ShowOutputSchema } from '../lib/view-schemas.js';
import {
  UsageSnapshotSchema,
  ActiveSessionsSnapshotSchema,
} from '../lib/account-view-schemas.js';
import { formatNumber, formatTimestamp, formatDuration } from './host.mjs';
import './account-view.css';

const node = (tag, text, className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function mountAccountView(root, view, app, initialHost = {}) {
  let host = { ...initialHost };
  const number = (value) => formatNumber(value, host);
  const date = (value) => formatTimestamp(value, host) ?? 'Unavailable';
  const usage = view.kind === 'usage';
  const schema = usage ? UsageSnapshotSchema : ActiveSessionsSnapshotSchema;
  let data = schema.parse(view.data),
    disposed = false,
    pending = false;
  let retryTimeframe;
  let expiryTimer;
  const controller = new AbortController();
  root.innerHTML = `<header><span class="account-icon" aria-hidden="true"></span><div><h1></h1><p data-role="scope"></p></div><label data-role="timeframe-label">Request window<select aria-label="Request timeframe"><option value="hour">Last hour</option><option value="day">Last day</option><option value="week">Last week</option></select></label><button data-role="refresh">Refresh</button></header><div data-role="body"></div><p data-role="error" role="alert" hidden></p><button data-role="retry" hidden>Retry update</button><footer><span data-role="updated"></span><span>Browserless</span></footer>`;
  const $ = (role) => root.querySelector(`[data-role="${role}"]`);
  const select = root.querySelector('select');
  $('timeframe-label').hidden = !usage;
  $('refresh').hidden = usage;
  root.querySelector('h1').textContent = usage
    ? 'Account usage'
    : 'Active sessions';
  root.querySelector('.account-icon').textContent = usage ? '◴' : '▤';

  function renderUsage(body) {
    select.value = data.timeframe;
    $('scope').textContent = data.apiKeyIds?.length
      ? `Requests: ${data.apiKeyIds.length} selected API key(s)`
      : 'Requests: whole account';
    const units = node('section', undefined, 'account-units');
    units.append(
      node('h2', 'Billed units'),
      node('p', 'Current billing period · All API keys', 'account-muted'),
    );
    if (data.units) {
      const { used, available, overageFee } = data.units;
      const headline = node('p', undefined, 'account-unit-total');
      headline.append(
        node('strong', number(used)),
        node('span', ` / ${number(available)} included`),
      );
      units.append(headline);
      if (used !== null && available !== null && available > 0) {
        const meter = node('progress');
        meter.max = available;
        meter.value = Math.min(used, available);
        meter.setAttribute(
          'aria-label',
          'Billing period units used versus included',
        );
        units.append(meter);
      }
      if (used !== null && available !== null && used > available) {
        units.classList.add('overage');
        units.append(
          node(
            'p',
            `${number(used - available)} units over the plan allotment${overageFee !== null ? ` · ${overageFee} per unit` : ''}`,
            'account-overage',
          ),
        );
      }
    } else
      units.append(
        node(
          'p',
          'Unit balance unavailable for this account.',
          'account-muted',
        ),
      );
    if (data.currentPeriodEnd !== null)
      units.append(
        node(
          'p',
          `Period ends ${date(data.currentPeriodEnd * 1000)}`,
          'account-muted',
        ),
      );
    body.append(units);

    const counters = data.counters;
    const section = node('section');
    section.append(node('h2', `Requests · Last ${data.timeframe}`));
    const hasCounters =
      counters &&
      Object.values(counters).some((value) => value !== null && value > 0);
    if (!hasCounters) {
      section.append(
        node(
          'p',
          (data.units?.used ?? 0) > 0
            ? 'No request counters were returned for this window and key scope, despite billed units. Counters are only populated for dedicated workers. Use request logs for per-request detail.'
            : !counters ||
                Object.values(counters).every((value) => value === null)
              ? 'Request counters are unavailable for this window.'
              : 'No requests recorded in this window.',
          'account-muted',
        ),
      );
    } else {
      const list = node('dl', undefined, 'account-counters');
      for (const [key, title] of [
        ['successful', 'Successful'],
        ['errored', 'Errored'],
        ['timedout', 'Timed out'],
        ['queued', 'Queued'],
        ['rejected', 'Rejected'],
        ['maxConcurrent', 'Peak concurrency'],
        ['captcha', 'Captchas solved'],
        ['proxy', 'Proxy bytes'],
      ]) {
        const item = node('div');
        item.append(node('dt', title), node('dd', number(counters[key])));
        list.append(item);
      }
      section.append(list);
    }
    body.append(section);
  }

  function renderSessions(body) {
    $('scope').textContent =
      data.count === null
        ? 'Running browsers · Total unavailable'
        : `${number(data.count)} running browser${data.count === 1 ? '' : 's'}`;
    if (!data.sessions.length) {
      body.append(
        node(
          'p',
          data.count > 0 || data.skip > 0
            ? 'No browsers on this page.'
            : data.count === null
              ? 'Active session data is unavailable.'
              : 'No browsers are running right now.',
          'account-empty',
        ),
      );
      return;
    }
    const scroll = node('div', undefined, 'account-table-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Active browser sessions');
    const table = node('table');
    table.setAttribute('role', 'table');
    const head = node('thead'),
      headers = node('tr');
    head.setAttribute('role', 'rowgroup');
    headers.setAttribute('role', 'row');
    for (const title of [
      'Session ID',
      'Browser',
      'Started',
      'Elapsed',
      'Type',
    ]) {
      const cell = node('th', title);
      cell.scope = 'col';
      cell.setAttribute('role', 'columnheader');
      headers.append(cell);
    }
    head.append(headers);
    const rows = node('tbody');
    rows.setAttribute('role', 'rowgroup');
    for (const session of data.sessions) {
      const row = node('tr');
      row.setAttribute('role', 'row');
      const start =
        session.startTime === null ? NaN : Date.parse(session.startTime);
      const elapsed = Number.isFinite(start)
        ? Math.max(0, Math.floor((Date.parse(data.fetchedAt) - start) / 1000))
        : null;
      for (const value of [
        session.browserId ?? 'Unavailable',
        session.browserName ?? 'Unavailable',
        session.startTime === null ? 'Unavailable' : date(session.startTime),
        elapsed === null ? 'Unavailable' : formatDuration(elapsed, host),
        session.type ?? 'Unavailable',
      ]) {
        const cell = node('td', value);
        cell.setAttribute('role', 'cell');
        cell.dataset.label = headers.children[row.children.length].textContent;
        row.append(cell);
      }
      rows.append(row);
    }
    table.append(head, rows);
    scroll.append(table);
    body.append(
      scroll,
      node(
        'p',
        `Showing ${data.skip + 1}–${data.skip + data.sessions.length}${data.count !== null ? ` of ${number(data.count)}` : ''}. Page URLs are not provided by this API.`,
        'account-muted',
      ),
    );
  }

  function render() {
    const body = $('body');
    body.replaceChildren();
    if (usage) renderUsage(body);
    else renderSessions(body);
    $('updated').textContent = `Snapshot · ${date(data.fetchedAt)}`;
  }
  function busy(value) {
    pending = value;
    root.setAttribute('aria-busy', String(value));
    select.disabled = value;
    $('refresh').disabled = value;
    $('retry').disabled = value;
  }
  async function refresh(timeframe = data.timeframe) {
    if (pending || disposed) return;
    retryTimeframe = timeframe;
    if (Date.parse(view.expiresAt) <= Date.now()) {
      fail(new Error('This view has expired. Ask for a new snapshot.'));
      return;
    }
    busy(true);
    try {
      const result = await app.callServerTool({
        name: usage ? 'browserless_usage' : 'browserless_sessions',
        arguments: usage
          ? {
              timeframe,
              ...(data.apiKeyIds ? { apiKeyIds: data.apiKeyIds } : {}),
            }
          : { action: 'active', limit: data.limit, skip: data.skip },
      });
      if (disposed) return;
      if (result.isError) throw new Error('Update failed.');
      const next = ShowOutputSchema.parse(result.structuredContent);
      if (next.kind !== view.kind) throw new Error('Unexpected result.');
      data = schema.parse(next.data);
      view = next;
      render();
      $('error').hidden = true;
      $('retry').hidden = true;
      scheduleExpiry();
    } catch {
      if (disposed) return;
      select.value = data.timeframe ?? 'day';
      $('error').textContent =
        'Could not update. Showing the last successful snapshot.';
      $('error').hidden = false;
      $('retry').hidden = false;
    } finally {
      if (!disposed) busy(false);
    }
  }
  select.addEventListener('change', () => void refresh(select.value), {
    signal: controller.signal,
  });
  $('refresh').addEventListener('click', () => void refresh(), {
    signal: controller.signal,
  });
  $('retry').addEventListener('click', () => void refresh(retryTimeframe), {
    signal: controller.signal,
  });
  function fail(error) {
    clearTimeout(expiryTimer);
    disposed = true;
    controller.abort();
    busy(true);
    $('error').textContent =
      error.message || 'This account view is unavailable.';
    $('error').hidden = false;
    $('retry').hidden = true;
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const remaining = Date.parse(view.expiresAt) - Date.now();
    const expire = () =>
      fail(new Error('This view has expired. Request a new account snapshot.'));
    if (remaining <= 0) expire();
    else expiryTimer = setTimeout(expire, remaining);
  }
  render();
  scheduleExpiry();
  return {
    fail,
    updateHost(context) {
      if (disposed) return;
      const next = { ...host, ...context };
      const changed =
        next.locale !== host.locale || next.timeZone !== host.timeZone;
      host = next;
      if (!changed) return;
      const scroll = root.querySelector('.account-table-scroll');
      const focused = scroll && root.ownerDocument.activeElement === scroll;
      const left = scroll?.scrollLeft,
        top = scroll?.scrollTop;
      const timeframe = select.value;
      render();
      if (pending) select.value = timeframe;
      if (scroll) {
        const replacement = root.querySelector('.account-table-scroll');
        if (focused) replacement.focus({ preventScroll: true });
        replacement.scrollLeft = left;
        replacement.scrollTop = top;
      }
    },
    dispose() {
      clearTimeout(expiryTimer);
      disposed = true;
      controller.abort();
      root.replaceChildren();
    },
  };
}
