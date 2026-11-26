import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import {
  chrome,
  REPORT_SCRIPT,
  runHostPage,
} from '../helpers/widget-browser.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/agent-run.json', 'utf8'),
);

describe('hosted agent run timeline browser', () => {
  (chrome ? it : it.skip)(
    'renders a read-only timeline and preserves the snapshot and disclosures across refreshes under CSP',
    async function () {
      this.timeout(30000);
      const widget = readFileSync('build/src/ui/view.html', 'utf8');
      const screenshotPath = process.env.AGENT_RUN_SCREENSHOT_PATH;
      const host = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
      import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
      ${REPORT_SCRIPT}
      const fixture = ${JSON.stringify(fixture)};
      const assert = (ok, message) => { if (!ok) throw new Error(message); };
      function until(doc, check) {
        if (check()) return Promise.resolve();
        return new Promise(resolve => {
          const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
          observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
        });
      }
      function result(status = 'running', lifetime = 60000) {
        const active = ['pending', 'running', 'needs_human'].includes(status);
        const payload = {
          status, runId: fixture.id, createdAt: fixture.created_at, completedAt: active ? null : fixture.completed_at,
          runExpiresAt: fixture.expires_at, fetchedAt: fixture.created_at, error: null,
          humanRequest: { ...fixture.humanRequest, outcome: status === 'succeeded' ? 'resumed' : null },
          screenshot: { state: 'unavailable', reason: 'fixture capture unavailable' }, turnsTruncated: false,
          turns: fixture.turns.map(({ steps, data, ...turn }) => ({
            ...turn, notes: steps, answer: data?.answer ?? null, result: data ? JSON.stringify(data) : null,
            actionsTruncated: false, notesTruncated: false, resultTruncated: false,
          })),
        };
        return { content: [{ type: 'text', text: 'Hosted agent run' }], structuredContent: {
          kind: 'agent-run', viewRef: 'run-fixture-view', expiresAt: new Date(Date.now() + lifetime).toISOString(), summary: 'Agent run',
          data: { active, runId: payload.runId, status, fetchedAt: payload.fetchedAt, createdAt: payload.createdAt,
            completedAt: payload.completedAt, runExpiresAt: payload.runExpiresAt, turnCount: 2,
            actionCount: 3, failedActionCount: 1, incompleteActionCount: 1 },
        }, _meta: { payload } };
      }
      const calls = [], copied = [], violations = [];
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-scripts allow-same-origin';
      frame.allow = 'clipboard-write';
      document.body.append(frame);
      const bridge = new AppBridge(null, { name: 'Browser test', version: '1.0.0' }, { serverTools: {} }, {
        hostContext: { theme: 'dark', locale: 'en-GB', timeZone: 'UTC' },
      });
      let reply;
      let resolveCall;
      const nextCall = () => new Promise(resolve => { resolveCall = resolve; });
      bridge.oncalltool = async call => {
        calls.push(call);
        resolveCall();
        return reply;
      };
      try {
        const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
        await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
        frame.src = '/widget'; await ready;
        const doc = frame.contentDocument;
        doc.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
        Object.defineProperty(doc.defaultView.navigator, 'clipboard', {
          value: { writeText: async value => copied.push(value) },
        });
        const mount = async initial => {
          const root = doc.querySelector('#agent-run');
          const previous = root?.firstChild;
          await bridge.sendToolResult(initial);
          await until(doc, () => !doc.querySelector('.replay-card').hidden || (root && !root.hidden && root.firstChild !== previous));
          assert(root && !root.hidden && doc.querySelector('.replay-card').hidden, 'Agent run did not mount its timeline');
          return root;
        };
        const root = await mount(result('needs_human'));
        const button = text => Array.from(root.querySelectorAll('button:not([hidden])')).find(item => item.textContent.trim() === text);
        const rows = () => [...root.querySelectorAll('button[aria-expanded]')];
        const seqs = () => rows().map(row => row.textContent.trim().match(/^\\d+/)?.[0]).join(',');
        const open = row => row.getAttribute('aria-expanded') === 'true';
        const details = text => [...root.querySelectorAll('details')].find(detail => detail.querySelector('summary').textContent === text);
        assert(root.textContent.includes('Needs human') && root.textContent.includes('Waiting for a person to take over — sign-in needed'), 'Paused run state is missing');
        assert(!root.textContent.includes('FORBIDDEN') && !root.querySelector('a'), 'A private handoff field was exposed');
        assert(seqs() === '1,2,3' && rows().every(row => !open(row)), 'Actions are unordered or open by default');
        assert(rows()[2].textContent.includes('Incomplete') && rows()[2].textContent.includes('Unavailable'), 'Incomplete action lost its label or missing duration');
        assert(root.textContent.includes('No steps recorded') && root.textContent.includes('Task unavailable') && root.textContent.includes('Result unavailable.'), 'Empty turn fabricated data');
        const failed = rows()[1];
        failed.click();
        const panel = doc.getElementById(failed.getAttribute('aria-controls'));
        assert(open(failed) && panel && !panel.hidden && panel.textContent.includes('SELECTOR_MISS'), 'Failure details did not expand');
        assert(panel.textContent.includes('type #search (7 chars typed)'), 'Command details lost typed length');
        failed.click();
        // A real click gives the widget frame focus first; headless Chrome does not
        // reliably do that for synthetic clicks, and focus() is a no-op in an unfocused frame.
        frame.contentWindow.focus();
        assert(doc.hasFocus(), 'Widget frame did not take focus');
        button('Jump to first failure').click();
        assert(open(failed) && doc.activeElement === failed, 'Jump did not expand and focus the failed action');
        const notes = details('2 agent notes'), final = details('Final result');
        assert(notes && final && !notes.open && !final.open, 'Notes and result must be initially collapsed');
        notes.open = final.open = true;
        assert(notes.textContent.includes('<em>plain text</em>') && !notes.querySelector('em'), 'Note markup was interpreted');
        const copy = final.querySelector('[aria-label="Copy result"]');
        assert(copy && final.textContent.includes('Example Domain'), 'Final answer or copy control is missing');
        copy.click();
        await until(doc, () => copy.textContent === 'Copied');
        assert(copied[0] === '{"answer":"Example Domain"}', 'Copy did not prefer the structured result');

        let release;
        reply = new Promise(resolve => { release = resolve; });
        const started = nextCall();
        const refresh = button('Refresh');
        refresh.click(); refresh.click(); await started;
        assert(refresh.disabled && calls.length === 1 && calls[0].name === 'browserless_agent_runs' &&
          JSON.stringify(calls[0].arguments) === JSON.stringify({ action: 'get', runId: fixture.id }), 'Refresh did not issue one read for this run');
        const next = result();
        next._meta.payload.turns[0].actions.push({ ...fixture.turns[0].actions[1], seq: 4 });
        next.structuredContent.data.actionCount = 4;
        release(next);
        await until(doc, () => rows().length === 4);
        assert(seqs() === '1,2,3,4' && open(rows()[1]) && details('2 agent notes').open && details('Final result').open, 'Refresh lost disclosures or duplicated actions');

        reply = { isError: true, content: [{ type: 'text', text: 'Read failed' }] };
        void nextCall(); button('Refresh').click();
        await until(doc, () => Boolean(button('Retry')));
        assert(seqs() === '1,2,3,4' && root.textContent.includes('Could not update. Showing the last successful snapshot.'), 'Failed refresh replaced the last snapshot');
        const mismatch = result();
        mismatch._meta.payload.runId = mismatch.structuredContent.data.runId = 'run_other';
        reply = mismatch;
        const mismatched = nextCall(); button('Retry').click(); await mismatched;
        await until(doc, () => button('Retry') && !button('Retry').disabled);
        assert(seqs() === '1,2,3,4' && !root.textContent.includes('run_other'), 'Refresh displayed a different run');
        reply = result('succeeded');
        void nextCall(); button('Retry').click();
        await until(doc, () => !button('Refresh'));
        assert(!button('Retry') && root.textContent.includes('Handoff: sign-in needed — resumed'), 'Completed run did not replace the active snapshot');

        const screenshot = result('succeeded');
        screenshot._meta.payload.screenshot = { state: 'available', viewRef: 'capture-fixture' };
        await mount(screenshot);
        reply = result(); // A run view is not a media reply.
        const requested = nextCall(); button('Show final screenshot').click(); await requested;
        await until(doc, () => root.textContent.includes('Screenshot unavailable.'));
        assert(calls.at(-1).name === 'browserless_show' && calls.at(-1).arguments.viewRef === 'capture-fixture', 'Screenshot did not request its existing view');

        await mount(result('running', -1));
        assert(root.textContent.includes('This view has expired. Open the run again.') && !button('Refresh') && rows().length === 0, 'An expired view kept its snapshot');
        await mount(result());
        reply = result('running', 2000);
        const renewed = nextCall(); button('Refresh').click(); await renewed;
        await until(doc, () => root.textContent.includes('This view has expired. Open the run again.'));
        assert(rows().length === 0, 'Refresh did not reschedule expiry');
        await mount(result());
        await bridge.sendToolCancelled({ reason: 'User cancelled run view' });
        await until(doc, () => root.textContent.includes('User cancelled run view'));
        assert(rows().length === 0, 'Cancelled view kept its snapshot');
        const capped = result('succeeded');
        capped._meta.payload.turnsTruncated = true;
        capped._meta.payload.omittedFinalResult = 'Actual final result after omitted turns';
        await mount(capped);
        const cappedFinal = details('Run final result');
        assert(cappedFinal && cappedFinal.querySelector('pre').textContent === capped._meta.payload.omittedFinalResult, 'Capped timeline hid the actual final result');
        // A host may send multiple show results to the same widget instance.
        for (const runId of ['run_first', 'run_second', 'run_third']) {
          const shown = result('succeeded');
          shown._meta.payload.runId = shown.structuredContent.data.runId = runId;
          shown.structuredContent.viewRef = 'view-' + runId;
          await mount(shown);
          const ids = [...root.querySelectorAll('.run-id code')].map(id => id.textContent);
          assert(ids.join(',') === runId, 'Reused instance did not replace the previous timeline');
        }
        await bridge.teardownResource({});
        assert(root.hidden, 'Teardown did not hide the timeline');
        if (${Boolean(screenshotPath)}) {
          capped._meta.payload.screenshot = { state: 'none' };
          await mount(capped);
          details('Run final result').open = true;
        }
        assert(violations.length === 0, 'Unexpected CSP violations: ' + violations.join(', '));
        await report('PASS: hosted agent run timeline');
      } catch (error) { await report('FAIL: ' + error.message); }
    `,
        },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        write: false,
      });
      const result = await runHostPage({
        timeout: 25000,
        args: screenshotPath
          ? [
              '--virtual-time-budget=12000',
              `--screenshot=${screenshotPath}`,
              '--window-size=800,1000',
              '--force-device-scale-factor=2',
            ]
          : [],
        widget: widget,
        host: host.outputFiles[0].text,
        style:
          'body{background:#1d1d1f;color:white}iframe{width:min(100%,760px);height:1000px;border:0}',
      });
      assert.equal(result, 'PASS: hosted agent run timeline');
    },
  );
});
