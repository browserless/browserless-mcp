import {
  AGENT_RUN_RESULT_PREVIEW_CHARS,
  AgentRunPayloadSchema,
  AGENT_RUN_ACTION_LABELS,
  AGENT_RUN_STATUS_LABELS,
  agentRunOutcomeLabel,
  agentRunReasonLabel,
  formatAgentRunCommand,
  isActiveRun,
} from '../lib/agent-run-view.js';
import { ShowOutputSchema } from '../lib/view-schemas.js';
import { mountAgentMedia } from './agent-media.mjs';
import { formatNumber, formatTimestamp } from './host.mjs';
import './agent-run.css';

const expiredMessage = 'This view has expired. Open the run again.';
const updateMessage = 'Could not update. Showing the last successful snapshot.';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function showAgentRunFailure(root, error) {
  const message = node('p', error.message, 'run-banner error');
  message.setAttribute('role', 'alert');
  root.replaceChildren(node('h1', 'Agent run unavailable'), message);
}

export function mountAgentRun(root, rawPayload, initialView, app, initialHost) {
  const initial = AgentRunPayloadSchema.safeParse(rawPayload);
  if (!initial.success || initial.data.runId !== initialView.data.runId)
    throw new Error('Invalid agent run snapshot.');

  let payload = initial.data;
  let view = initialView;
  let host = initialHost ?? {};
  let expiryTimer, media, refreshButton, retryButton, updateError, feedback;
  let pending = false;
  const controller = new AbortController();
  const { signal } = controller;
  const expanded = new Set();
  const disclosures = new Map();
  const localize = [];
  const timestamp = (value) => formatTimestamp(value, host) ?? 'Unavailable';
  const duration = (value) => formatNumber(value, host, ' ms');
  const expired = () => Date.parse(view.expiresAt) <= Date.now();

  function localized(tag, format, className) {
    const element = node(tag, format(), className);
    localize.push(() => (element.textContent = format()));
    return element;
  }

  function button(text, action) {
    const element = node('button', text);
    element.type = 'button';
    element.onclick = action;
    return element;
  }

  function copyButton(value, label) {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    if (
      !navigator.clipboard?.writeText ||
      (policy && !policy.allowsFeature('clipboard-write'))
    )
      return [];
    const copy = button('Copy', async () => {
      try {
        await navigator.clipboard.writeText(value);
        if (copy.isConnected) copy.textContent = 'Copied';
      } catch {
        if (copy.isConnected)
          feedback.textContent =
            'Clipboard access is unavailable. Select the text and copy it manually.';
      }
    });
    copy.setAttribute('aria-label', `Copy ${label}`);
    return [copy];
  }

  function disclosure(key, title, openSections) {
    const detail = node('details');
    detail.open = openSections.has(key);
    detail.append(node('summary', title));
    disclosures.set(key, detail);
    return detail;
  }

  function render() {
    const openSections = new Set(
      [...disclosures].filter(([, detail]) => detail.open).map(([key]) => key),
    );
    disclosures.clear();
    localize.length = 0;
    media?.dispose();
    media = undefined;

    const heading = node('div', undefined, 'run-heading');
    const id = node('div', undefined, 'run-id');
    id.append(
      node('code', payload.runId),
      ...copyButton(payload.runId, 'run ID'),
    );
    const title = node('div');
    title.append(node('h1', 'Agent run timeline'), id);
    heading.append(
      title,
      node(
        'span',
        AGENT_RUN_STATUS_LABELS[payload.status],
        `run-chip ${payload.status}`,
      ),
    );
    const tools = node('div', undefined, 'run-controls');
    refreshButton = isActiveRun(payload.status)
      ? button('Refresh', refresh)
      : undefined;
    if (refreshButton) tools.append(refreshButton);

    const header = node('header');
    const dates = node('dl', undefined, 'run-dates');
    const elapsed =
      Date.parse(payload.completedAt) - Date.parse(payload.createdAt);
    for (const [label, format] of [
      ['Started', () => timestamp(payload.createdAt)],
      [
        'Duration',
        () =>
          payload.completedAt === null && isActiveRun(payload.status)
            ? 'In progress'
            : duration(
                Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
              ),
      ],
      ['Expires', () => timestamp(payload.runExpiresAt)],
    ]) {
      const group = node('div');
      group.append(node('dt', label), localized('dd', format));
      dates.append(group);
    }
    header.append(heading, dates, tools);

    const contents = document.createDocumentFragment();
    contents.append(header);
    if (payload.error !== null)
      contents.append(node('p', payload.error, 'run-banner error'));
    if (payload.humanRequest) {
      const { reason, outcome } = payload.humanRequest;
      const label = agentRunReasonLabel(reason);
      if (payload.status === 'needs_human')
        contents.append(
          node(
            'p',
            `Waiting for a person to take over — ${label}`,
            'run-banner',
          ),
        );
      if (outcome !== null)
        contents.append(
          node(
            'p',
            `Handoff: ${label} — ${agentRunOutcomeLabel(outcome)}`,
            'run-banner',
          ),
        );
    }
    feedback = node('p', undefined, 'run-feedback');
    feedback.setAttribute('role', 'status');
    updateError = node('p', updateMessage, 'run-banner');
    updateError.setAttribute('role', 'alert');
    updateError.hidden = true;
    retryButton = button('Retry', refresh);
    retryButton.hidden = true;
    contents.append(feedback, updateError, retryButton);

    let firstFailure;
    if (!payload.turns.length) contents.append(node('p', 'No turns recorded.'));
    payload.turns.forEach((turn, index) => {
      const section = node('section', undefined, 'run-turn');
      const actions = [...turn.actions].sort((a, b) => a.seq - b.seq);
      const failures = actions.filter(
        ({ status }) => status === 'error',
      ).length;
      section.append(
        node('h2', `Turn ${index + 1}`),
        node('p', turn.query ?? 'Task unavailable', 'run-task'),
        node('h3', `${actions.length} actions · ${failures} failed`),
      );
      if (!actions.length && !turn.notes.length)
        section.append(node('p', 'No steps recorded'));
      const list = node('ol', undefined, 'run-actions');
      actions.forEach((action, actionIndex) => {
        const key = `${turn.turnId}:${action.seq}`;
        const row = node('li', undefined, `run-action ${action.status}`);
        const panel = node('div', undefined, 'run-action-detail');
        panel.id = `run-action-${index}-${actionIndex}`;
        const toggle = button(undefined, () => setOpen(panel.hidden));
        toggle.setAttribute('aria-controls', panel.id);
        toggle.append(
          node('span', String(action.seq), 'run-seq'),
          node('span', action.tool, 'run-tool'),
          node(
            'span',
            AGENT_RUN_ACTION_LABELS[action.status],
            `run-chip ${action.status}`,
          ),
          localized('span', () => duration(action.durationMs), 'run-duration'),
        );
        function setOpen(open) {
          toggle.setAttribute('aria-expanded', String(open));
          panel.hidden = !open;
          if (open) expanded.add(key);
          else expanded.delete(key);
        }
        setOpen(expanded.has(key));
        if (!firstFailure && action.status === 'error') {
          firstFailure = () => {
            setOpen(true);
            toggle.scrollIntoView({ block: 'nearest' });
            toggle.focus({ preventScroll: true });
          };
        }
        for (const command of action.commands)
          panel.append(
            node('code', formatAgentRunCommand(command), 'run-command'),
          );
        panel.append(
          localized('p', () => `Started: ${timestamp(action.startedAt)}`),
          localized('p', () => `Duration: ${duration(action.durationMs)}`),
        );
        if (action.errorCode !== undefined)
          panel.append(node('p', `Error: ${action.errorCode}`));
        row.append(toggle, panel);
        list.append(row);
      });
      if (actions.length) section.append(list);
      if (turn.actionsTruncated)
        section.append(node('p', 'Showing the first 500 actions.'));

      if (turn.notes.length) {
        const notes = disclosure(
          `notes:${turn.turnId}`,
          `${turn.notes.length} agent notes`,
          openSections,
        );
        const entries = node('ul');
        for (const note of turn.notes) entries.append(node('li', note));
        notes.append(entries);
        if (turn.notesTruncated)
          notes.append(node('p', 'Agent notes truncated.'));
        section.append(notes);
      }
      const result = disclosure(
        `result:${turn.turnId}`,
        'Final result',
        openSections,
      );
      if (turn.answer !== null)
        result.append(node('p', turn.answer, 'run-answer'));
      else if (turn.result !== null) result.append(node('pre', turn.result));
      else result.append(node('p', 'Result unavailable.'));
      const copy = turn.result ?? turn.answer;
      if (copy !== null) result.append(...copyButton(copy, 'result'));
      if (turn.resultTruncated) result.append(node('p', 'Result truncated.'));
      section.append(result);
      contents.append(section);
    });
    if (view.data.failedActionCount > 0 && firstFailure)
      tools.append(button('Jump to first failure', firstFailure));
    tools.hidden = !tools.childElementCount;
    if (payload.turnsTruncated) {
      contents.append(node('p', 'Additional turns were truncated.'));
      const result = disclosure(
        'omitted-final-result',
        'Run final result',
        openSections,
      );
      const preview = payload.omittedFinalResult?.slice(
        0,
        AGENT_RUN_RESULT_PREVIEW_CHARS,
      );
      result.append(
        preview === undefined
          ? node('p', 'Result unavailable.')
          : node('pre', preview),
      );
      if (
        (payload.omittedFinalResult?.length ?? 0) >
        AGENT_RUN_RESULT_PREVIEW_CHARS
      )
        result.append(node('p', 'Result preview truncated.'));
      contents.append(result);
    }

    const screenshot = payload.screenshot;
    if (screenshot.state === 'available') {
      const capture = node('div');
      const load = button('Show final screenshot', () =>
        showScreenshot(screenshot.viewRef, capture, load),
      );
      contents.append(load, capture);
    } else if (screenshot.state === 'unavailable') {
      contents.append(
        node('p', `Screenshot unavailable (${screenshot.reason}).`),
      );
    }
    contents.append(
      localized(
        'footer',
        () => `Snapshot · ${timestamp(payload.fetchedAt)} · Read only`,
      ),
    );
    root.replaceChildren(contents);
  }

  async function showScreenshot(viewRef, capture, load) {
    if (signal.aborted || load.disabled) return;
    if (expired()) return fail(new Error(expiredMessage));
    load.disabled = true;
    try {
      const result = await app.callServerTool(
        { name: 'browserless_show', arguments: { viewRef } },
        { signal },
      );
      if (signal.aborted || !capture.isConnected) return;
      if (expired()) return fail(new Error(expiredMessage));
      const mediaView = ShowOutputSchema.parse(result.structuredContent);
      if (
        result.isError ||
        mediaView.kind !== 'agent-media' ||
        mediaView.viewRef !== viewRef ||
        Date.parse(mediaView.expiresAt) <= Date.now()
      )
        throw new Error('Invalid screenshot view.');
      const mediaRoot = node('section', undefined, 'agent-media');
      mediaRoot.setAttribute('aria-label', 'Final screenshot');
      media = mountAgentMedia(
        mediaRoot,
        result._meta?.payload,
        mediaView,
        app,
        host,
      );
      capture.replaceChildren(mediaRoot);
      load.hidden = true;
    } catch {
      if (signal.aborted || !capture.isConnected) return;
      const message = node('p', 'Screenshot unavailable.');
      message.setAttribute('role', 'status');
      capture.replaceChildren(message);
      load.disabled = false;
    }
  }

  async function refresh() {
    if (signal.aborted || pending || !isActiveRun(payload.status)) return;
    if (expired()) return fail(new Error(expiredMessage));
    pending = true;
    root.setAttribute('aria-busy', 'true');
    const focus = [refreshButton, retryButton].includes(document.activeElement);
    refreshButton.disabled = retryButton.disabled = true;
    try {
      const result = await app.callServerTool(
        {
          name: 'browserless_agent_runs',
          arguments: { action: 'get', runId: payload.runId },
        },
        { signal },
      );
      if (signal.aborted) return;
      if (expired()) return fail(new Error(expiredMessage));
      if (result.isError) throw new Error('Run update failed.');
      const nextView = ShowOutputSchema.parse(result.structuredContent);
      const next = AgentRunPayloadSchema.parse(result._meta?.payload);
      if (
        nextView.kind !== 'agent-run' ||
        nextView.data.runId !== payload.runId ||
        next.runId !== payload.runId ||
        Date.parse(nextView.expiresAt) <= Date.now()
      )
        throw new Error('Invalid updated snapshot.');
      view = nextView;
      payload = next;
      render();
      scheduleExpiry();
      if (focus) refreshButton?.focus();
    } catch {
      if (signal.aborted) return;
      updateError.hidden = retryButton.hidden = false;
    } finally {
      if (!signal.aborted) {
        pending = false;
        root.removeAttribute('aria-busy');
        if (refreshButton) refreshButton.disabled = false;
        retryButton.disabled = false;
        if (focus && !retryButton.hidden) retryButton.focus();
      }
    }
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (expired()) fail(new Error(expiredMessage));
    else
      expiryTimer = setTimeout(
        scheduleExpiry,
        Math.min(2 ** 31 - 1, Date.parse(view.expiresAt) - Date.now()),
      );
  }

  function dispose() {
    controller.abort();
    clearTimeout(expiryTimer);
    media?.dispose();
    media = undefined;
    root.removeAttribute('aria-busy');
    root.replaceChildren();
    localize.length = 0;
    expanded.clear();
    disclosures.clear();
  }

  function fail(error) {
    dispose();
    showAgentRunFailure(root, error);
  }

  if (!expired()) render();
  scheduleExpiry();
  return {
    fail,
    dispose,
    updateHost(context) {
      const { locale, timeZone } = host;
      host = { ...host, ...context };
      if (locale !== host.locale || timeZone !== host.timeZone)
        for (const update of localize) update();
      media?.updateHost(context);
    },
  };
}
