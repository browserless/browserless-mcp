import {
  LiveURLViewSchema,
  LiveViewerURLSchema,
} from '../lib/live-url-view.js';
import './handoff.css';

export function mountLiveURL(root, result, app) {
  const action = result.structuredContent?.action;
  if (
    !result.isError &&
    !['create', 'unavailable', 'expired'].includes(action)
  ) {
    root.replaceChildren();
    return;
  }
  let timer;
  root.innerHTML =
    '<header><span class="handoff-icon" aria-hidden="true">↗</span><div><h1>Live browser</h1><p>View an existing browser session</p></div></header><p data-role="message" role="status"></p><iframe title="Live browser viewer" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" hidden></iframe><footer><a target="_blank" rel="noreferrer" hidden>Open in a new tab</a></footer><p class="handoff-hint">Creating a viewer does not keep the browser alive or pause automation. Use a human handoff when the agent needs to wait for you.</p>';
  const message = root.querySelector('[data-role="message"]');
  const frame = root.querySelector('iframe');
  const link = root.querySelector('a');
  function fail(error) {
    clearTimeout(timer);
    frame.removeAttribute('src');
    frame.hidden = true;
    link.removeAttribute('href');
    link.hidden = true;
    message.textContent = error.message || 'Live viewer unavailable.';
  }
  try {
    if (result.isError)
      throw new Error(
        'Unable to complete the live viewer request. Check the tool response in the conversation.',
      );
    if (action !== 'create') {
      message.textContent =
        action === 'expired'
          ? 'The live viewer has already expired. Its URL can no longer be used.'
          : 'The viewer was created, but cannot be embedded. Use the URL in the tool response; do not create another viewer.';
    } else {
      const view = LiveURLViewSchema.parse(result.structuredContent);
      const url = new URL(
        LiveViewerURLSchema.parse(result._meta?.payload?.liveURL),
      );
      if (url.searchParams.get('i') !== view.liveURLId)
        throw new Error('Invalid live viewer ID.');
      // A duration avoids comparing the server's clock with the host's clock.
      // The backend enforces actual expiry, including restored/delayed results.
      const remaining = view.remainingMs;
      if (remaining <= 0) throw new Error('Live viewer expired.');
      message.textContent =
        'Live viewer ready. If embedding is blocked, open it in a new tab.';
      frame.src = url.href;
      frame.hidden = false;
      link.href = url.href;
      link.hidden = false;
      link.onclick = async (event) => {
        if (!app.getHostCapabilities()?.openLinks) return;
        event.preventDefault();
        try {
          const opened = await app.openLink({ url: url.href });
          if (opened.isError) throw new Error('Link rejected');
        } catch {
          message.textContent =
            'The host could not open the viewer. Use the link’s browser context menu to open it in a new tab.';
        }
      };
      timer = setTimeout(
        () => fail(new Error('Live viewer expired.')),
        remaining,
      );
    }
  } catch (error) {
    fail(
      error.name === 'ZodError'
        ? new Error('Invalid live viewer data.')
        : error,
    );
  }
  return {
    fail,
    dispose() {
      clearTimeout(timer);
      frame.removeAttribute('src');
      link.onclick = null;
    },
  };
}
