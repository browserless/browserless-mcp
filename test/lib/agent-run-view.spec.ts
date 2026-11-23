import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAgentRun,
  formatAgentRunText,
  formatAgentRunList,
} from '../../src/lib/agent-run-view.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/agent-run.json', 'utf8'),
);
const now = '2026-11-20T12:01:00.000Z';

describe('agent run snapshot', () => {
  it('keeps every summary key and puts actions in call order', () => {
    const { payload, summary } = buildAgentRun(fixture, now);
    const view = {
      viewRef: 'view_fixture',
      kind: 'agent-run',
      summary: 'Ready',
      expiresAt: now,
      data: summary,
    };
    assert.deepEqual(ShowOutputSchema.parse(view), view);
    assert.deepEqual(
      payload.turns[0].actions.map(({ seq, status }) => [seq, status]),
      [
        [1, 'ok'],
        [2, 'error'],
        [3, 'incomplete'],
      ],
    );
    assert.deepEqual(
      [
        summary.turnCount,
        summary.actionCount,
        summary.failedActionCount,
        summary.incompleteActionCount,
      ],
      [2, 3, 1, 1],
    );
    const fallback = formatAgentRunText(payload, summary, { timeline: true });
    assert.match(
      fallback,
      /^1\. browserless_navigate[^\n]*\n2\. browserless_interact[^\n]*\n3\. browserless_observe/m,
    );
    assert.match(fallback, /## Turn 2: Task unavailable\nNo steps recorded\./);
    assert.doesNotMatch(
      formatAgentRunText(payload, summary, { timeline: false }),
      /browserless_navigate|#missing/,
    );
  });

  it('bounds transcripts and result previews independently', () => {
    const turn = fixture.turns[0];
    const source = {
      ...fixture,
      turns: [
        {
          ...turn,
          actions: Array.from({ length: 501 }, (_, i) => ({
            ...turn.actions[0],
            seq: 501 - i,
          })),
          steps: Array.from({ length: 201 }, () => 'n'.repeat(2001)),
          data: { answer: 'a'.repeat(270000) },
        },
      ],
    };
    const { payload, summary } = buildAgentRun(source, now);
    const bounded = payload.turns[0];
    assert.equal(bounded.actions.length, 500);
    assert.equal(bounded.actions[0].seq, 1);
    assert.equal(bounded.actions.at(-1)?.seq, 500);
    assert.equal(bounded.actionsTruncated, true);
    assert.equal(bounded.notes.length, 200);
    assert.equal(bounded.notes[0].length, 2000);
    assert.equal(bounded.notesTruncated, true);
    assert.equal(bounded.result?.length, 262144);
    assert.equal(bounded.resultTruncated, true);
    assert.match(
      formatAgentRunText(payload, summary, { timeline: false }),
      /Result \(first 4,000 characters, truncated\):\na{4000}$/,
    );
  });

  it('reports the true final result even when the transcript is capped', () => {
    const turn = fixture.turns[1];
    const run = buildAgentRun(
      {
        ...fixture,
        turns: [
          ...Array.from({ length: 20 }, () => ({
            ...turn,
            data: { answer: 'earlier answer' },
          })),
          { ...turn, data: { answer: 'actual final answer' } },
        ],
      },
      now,
    );
    const text = formatAgentRunText(run.payload, run.summary, {
      timeline: true,
    });
    assert.equal(run.payload.turns.length, 20);
    assert.match(
      text,
      /Result:\nactual final answer\nAdditional turns were truncated\./,
    );
  });

  it('states why a run is paused without passing handoff or page captures through', () => {
    const { payload, summary } = buildAgentRun(
      { ...fixture, status: 'needs_human' },
      now,
    );
    const text = formatAgentRunText(payload, summary, { timeline: true });
    assert.equal(summary.active, true);
    assert.match(text, /Waiting for a person to take over — sign-in needed\./);
    assert.doesNotMatch(
      JSON.stringify(payload) + text,
      /FORBIDDEN|forbidden-links|2099-01-01/,
    );
    assert.match(text, /Result: unavailable\./);
    const finished = buildAgentRun(
      {
        ...fixture,
        status: 'failed',
        humanRequest: { reason: 'login_wall', outcome: 'userFailed' },
      },
      now,
    );
    assert.match(
      formatAgentRunText(finished.payload, finished.summary, {
        timeline: false,
      }),
      /Handoff: sign-in needed — the person couldn't finish\./,
    );
    assert.throws(
      () => buildAgentRun(null, now),
      /Unexpected agent run response/,
    );
  });

  it('formats empty and paginated lists', () => {
    assert.equal(
      formatAgentRunList({ runs: [], nextCursor: null }),
      'No agent runs found.',
    );
    assert.equal(
      formatAgentRunList({
        runs: [
          {
            id: 'run_example',
            status: 'timed_out',
            created_at: now,
            completed_at: null,
            expires_at: null,
            queryPreview: null,
          },
        ],
        nextCursor: 'next-page',
      }),
      `## Agent runs (1)\n- run_example · Timed out · ${now} · Task unavailable\nMore runs are available — pass cursor: "next-page".`,
    );
  });
});
