import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import Player from 'rrweb-player';
import 'rrweb-player/dist/style.css';

const app = new App({ name: 'Browserless Session Replay', version: '1.0.0' });
const status = document.getElementById('status');
const target = document.getElementById('player');
let player;

function destroy() {
  player?.$destroy();
  player = undefined;
  target.replaceChildren();
}

function showError(error) {
  destroy();
  status.textContent = `Unable to play recording: ${error.message}`;
}

app.ontoolresult = (result) => {
  destroy();
  const summary = result.structuredContent;
  status.textContent = summary?.summary ?? 'No recording returned.';
  const replay = result._meta?.replay;
  if (!replay) return;
  if (!Array.isArray(replay.events) || replay.events.length < 2) {
    showError(new Error('Recording has no playable events.'));
    return;
  }
  try {
    player = new Player({
      target,
      props: {
        events: replay.events,
        width: Math.max(240, Math.min(window.innerWidth - 32, 1024)),
        height: 420,
        autoPlay: false,
        showController: true,
      },
    });
    const buttons = target.querySelectorAll('.rr-controller__btns button');
    buttons[0]?.setAttribute('aria-label', 'Play or pause recording');
    buttons[buttons.length - 1]?.setAttribute(
      'aria-label',
      'Toggle fullscreen',
    );
    status.textContent = `${replay.sessionId} · ${replay.website ?? 'Recorded session'} · ${replay.events.length} events`;
  } catch (error) {
    showError(error);
  }
};
app.ontoolcancelled = () => {
  destroy();
  status.textContent = 'Replay loading cancelled.';
};
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
};
app.onteardown = async () => {
  destroy();
  return {};
};
window.addEventListener('resize', () => {
  player?.$set({
    width: Math.max(240, Math.min(window.innerWidth - 32, 1024)),
  });
  // rrweb updates its container width without recalculating snapshot scale.
  queueMicrotask(() => player?.triggerResize());
});
app
  .connect()
  .then(() => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  })
  .catch(showError);
