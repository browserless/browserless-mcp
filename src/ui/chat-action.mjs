import { buildChatHandoff } from '../lib/chat-handoff.js';
import './chat-action.css';

export function chatSupported(app) {
  const caps = app.getHostCapabilities();
  return Boolean(caps?.updateModelContext && caps?.message);
}

export function mountChatAction(container, app) {
  let controller;
  let pending = false;
  let disposed = false;

  function close() {
    controller?.abort();
    container.replaceChildren();
  }

  return {
    open({ handoff, message, previewLine, note }) {
      if (pending || disposed) return;
      close();
      controller = new AbortController();
      const { signal } = controller;
      container.innerHTML = `<section class="chat-preview" data-role="chat-preview" role="group" aria-label="Send to chat"><h2>Send to chat</h2><p data-role="chat-message"></p><p data-role="chat-note" hidden></p><ul data-role="chat-records" hidden></ul><p data-role="chat-status" role="status"></p><div class="chat-buttons"><button type="button" data-role="chat-send" hidden>Send to chat</button><button type="button" data-role="chat-cancel">Cancel</button></div></section>`;
      const $ = (role) => container.querySelector(`[data-role="${role}"]`);
      const status = $('chat-status');
      const send = $('chat-send');
      const cancel = $('chat-cancel');
      $('chat-message').textContent = message;
      cancel.addEventListener('click', close, { signal });
      let built;
      try {
        built = buildChatHandoff(handoff);
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      const count = built.records.length;
      const summary = $('chat-note');
      summary.textContent = `${count} record${count === 1 ? '' : 's'} · ${Math.ceil(built.bytes / 1024)} KB will be shared with the assistant.${note ? ` ${note}` : ''}`;
      summary.hidden = false;
      const list = $('chat-records');
      for (const record of built.records) {
        const item = document.createElement('li');
        item.textContent = previewLine(record);
        list.append(item);
      }
      list.hidden = false;
      send.hidden = false;
      send.addEventListener(
        'click',
        async () => {
          if (pending || send.hidden || signal.aborted) return;
          pending = send.disabled = cancel.disabled = true;
          status.textContent = '';
          let shared = false;
          try {
            await app.updateModelContext({
              content: [{ type: 'text', text: built.text }],
            });
            if (disposed) return;
            shared = true;
            const result = await app.sendMessage({
              role: 'user',
              content: [{ type: 'text', text: message }],
            });
            if (result.isError) throw new Error('Message rejected');
            if (signal.aborted) return;
            status.textContent = 'Sent to chat.';
            send.hidden = true;
            cancel.textContent = 'Close';
          } catch {
            if (signal.aborted) return;
            status.textContent = shared
              ? 'The host did not send the message. Your selection was shared; ask about it in chat.'
              : 'The host declined to share this selection. Nothing was sent.';
          } finally {
            pending = false;
            if (!signal.aborted) send.disabled = cancel.disabled = false;
          }
        },
        { signal },
      );
    },
    close,
    dispose() {
      disposed = true;
      close();
    },
  };
}
