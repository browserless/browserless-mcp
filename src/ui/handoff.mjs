import {
  HandoffStateSchema,
  HandoffSummarySchema,
  VIEW_UNAVAILABLE,
} from '../lib/view-schemas.js';
import './handoff.css';

export function mountHandoff(root, payload, view, app, initialHost) {
  const summary = HandoffSummarySchema.parse(view.data);
  let state = HandoffStateSchema.parse(payload?.state),
    stopped = false,
    timer,
    polling = false,
    available = true;
  let host = initialHost ?? {};
  root.innerHTML = `<header><span class="handoff-icon" aria-hidden="true">↔</span><div><h1>Your turn</h1><p>The agent is waiting for your help</p></div><button data-role="expand" aria-label="Expand handoff">⛶</button></header><p data-role="instructions"></p><div class="handoff-status"><span data-role="status" role="status" aria-live="polite"></span><time data-role="time"></time></div><iframe title="Interactive browser for your human step" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe><footer><a data-role="external" target="_blank" rel="noreferrer">Open in a new tab</a><button data-role="refresh">Check status</button></footer><p class="handoff-hint" data-role="hint"></p>`;
  const $ = (role) => root.querySelector(`[data-role="${role}"]`);
  const iframe = root.querySelector('iframe');
  $('instructions').textContent = summary.instructions;
  let viewer;
  if (
    payload.liveURL &&
    Date.parse(view.expiresAt) > Date.now() &&
    state.status === 'open'
  ) {
    viewer = new URL(payload.liveURL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(viewer.hostname);
    if (
      !['https:', 'http:'].includes(viewer.protocol) ||
      (viewer.protocol === 'http:' && !local) ||
      viewer.username ||
      viewer.password ||
      !/^\/live(?:\/|$)/.test(viewer.pathname)
    )
      throw new Error('Invalid handoff viewer.');
    iframe.src = viewer.href;
    $('external').href = viewer.href;
  }
  function removeViewer() {
    iframe.removeAttribute('src');
    iframe.hidden = true;
    $('external').hidden = true;
  }
  function accessUnavailable(message) {
    return (
      message.includes(VIEW_UNAVAILABLE) ||
      /\b(?:401|403)\b|unauthori[sz]ed|forbidden|access denied/i.test(message)
    );
  }
  function unavailable() {
    stopped = true;
    clearInterval(timer);
    removeViewer();
    $('status').textContent = 'Handoff unavailable';
    $('refresh').disabled = true;
    $('hint').textContent =
      'This handoff is no longer available. Return to the conversation to check the existing browser.';
  }
  $('external').onclick = async (event) => {
    if (!app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    try {
      const result = await app.openLink({ url: viewer.href });
      if (result.isError) throw new Error('Link rejected');
    } catch {
      if (!stopped)
        $('hint').textContent =
          'The host could not open the viewer. Use the link’s browser context menu to open it in a new tab.';
    }
  };
  function render() {
    const open = state.status === 'open';
    $('status').textContent = open
      ? 'Waiting for you'
      : ({
          userDone: 'Step completed',
          userFailed: 'Couldn’t finish',
          viewerDisconnected: 'Viewer disconnected',
          timeout: 'Handoff expired',
          closed: 'Handoff closed',
        }[state.reason] ?? 'Handoff unavailable');
    $('hint').textContent = open
      ? 'Complete the step in the browser and choose Done. Then return to the conversation and reply “Continue”. If the embedded viewer is blocked, open it in a new tab.'
      : state.reason === 'userDone'
        ? 'The browser confirmed completion. Return to the conversation and reply “Continue”. The agent will check this handoff and take a fresh snapshot in the same browser.'
        : 'The step was not confirmed complete. Tell the agent what happened; your browser has not been replaced.';
    if (!open || !viewer) removeViewer();
    else {
      iframe.hidden = false;
      $('external').hidden = false;
    }
    renderTime();
  }
  function renderTime() {
    const seconds = Math.max(
      0,
      Math.ceil(
        (Math.min(state.expiresAt, Date.parse(view.expiresAt)) - Date.now()) /
          1000,
      ),
    );
    $('time').textContent =
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
  }
  async function check() {
    if (stopped || polling) return;
    polling = true;
    let stage = 'transport';
    try {
      const result = await app.callServerTool({
        name: 'browserless_handoff_state',
        arguments: { viewRef: view.viewRef },
      });
      if (stopped) return;
      if (result.isError) {
        if (
          result.content?.some(
            (block) => block.type === 'text' && accessUnavailable(block.text),
          )
        ) {
          unavailable();
          return;
        }
        stage = 'tool-error';
        throw new Error('Handoff status unavailable.');
      }
      stage = 'invalid-response';
      state = HandoffStateSchema.parse(
        result.structuredContent ??
          JSON.parse(
            result.content?.find((block) => block.type === 'text')?.text ??
              'null',
          ),
      );
      available = true;
      delete root.dataset.statusError;
      render();
    } catch (error) {
      if (stopped) return;
      if (accessUnavailable(error?.message ?? '')) {
        unavailable();
        return;
      }
      available = false;
      root.dataset.statusError = stage;
      $('status').textContent = 'Status check interrupted';
      $('hint').textContent =
        'Status could not be confirmed. You can keep using the live viewer or open it in a new tab. Check status again before continuing in chat.';
    } finally {
      polling = false;
    }
  }
  function updateHost(context) {
    if (stopped) return;
    host = { ...host, ...context };
    root.classList.toggle('expanded', host.displayMode === 'fullscreen');
    $('expand').setAttribute(
      'aria-label',
      host.displayMode === 'fullscreen' ? 'Collapse handoff' : 'Expand handoff',
    );
    $('expand').hidden = !host.availableDisplayModes?.includes('fullscreen');
  }
  $('expand').onclick = async () => {
    try {
      const result = await app.requestDisplayMode({
        mode: host.displayMode === 'fullscreen' ? 'inline' : 'fullscreen',
      });
      if (!stopped) updateHost({ displayMode: result.mode });
    } catch {
      if (!stopped) $('expand').hidden = true;
    }
  };
  $('refresh').onclick = check;
  const tick = () => {
    if (stopped) return;
    if (available) render();
    else renderTime();
    if (state.status === 'open' || !available) void check();
  };
  timer = setInterval(tick, 2000);
  render();
  updateHost(host);
  return {
    updateHost,
    fail(cause) {
      stopped = true;
      clearInterval(timer);
      removeViewer();
      $('status').textContent = /expired/i.test(cause?.message ?? '')
        ? 'Handoff expired'
        : 'Handoff unavailable';
      $('refresh').disabled = true;
      $('hint').textContent =
        'This view expired or lost access. Return to the conversation to check the existing browser.';
    },
    dispose() {
      stopped = true;
      clearInterval(timer);
      removeViewer();
      root.replaceChildren();
    },
  };
}
