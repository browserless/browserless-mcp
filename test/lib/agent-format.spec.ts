import { expect } from 'chai';

import {
  formatSnapshot,
  formatSnapshotDiff,
  pageSnapshot,
  shownBaseline,
} from '../../src/lib/agent-format.js';
import type {
  SnapshotElement,
  SnapshotResult,
} from '../../src/@types/types.js';

const snapshot = (element: Partial<SnapshotElement>): SnapshotResult => ({
  url: 'https://example.com',
  title: 'Example',
  time: 1,
  elements: [
    {
      ref: 1,
      role: 'button',
      name: '',
      selector: 'button#action',
      tag: 'button',
      ...element,
    },
  ],
});

describe('formatSnapshot contextual signals', () => {
  it('renders contextual tokens before state and keeps intent last', () => {
    const output = formatSnapshot(
      snapshot({
        description: 'Ends the current session',
        formAction: '/logout',
        formMethod: 'post',
        autocomplete: 'current-password',
        required: true,
        intentHint: 'signout',
      }),
    );

    expect(output).to.include(
      'ref=button#action desc="Ends the current session" action=POST /logout autocomplete=current-password (required) ⚠ sign-out',
    );
    expect(output.trimEnd()).to.match(/⚠ sign-out\n--- END SNAPSHOT ---$/);
  });

  it('omits contextual tokens when they are absent', () => {
    const output = formatSnapshot(snapshot({}));

    expect(output).to.not.include('desc=');
    expect(output).to.not.include('action=');
    expect(output).to.not.include('autocomplete=');
    expect(output).to.not.include('⚠');
  });

  it('uses the HTML default GET method when only an action is present', () => {
    expect(formatSnapshot(snapshot({ formAction: '/search' }))).to.include(
      'action=GET /search',
    );
  });

  for (const [intentHint, marker] of [
    ['destructive', '⚠ destructive'],
    ['signout', '⚠ sign-out'],
    ['signin', 'sign-in'],
    ['reset', 'reset'],
  ] as const) {
    it(`renders the ${intentHint} intent marker`, () => {
      const output = formatSnapshot(snapshot({ intentHint }));
      expect(output).to.include(`ref=button#action ${marker}`);
    });
  }
});

describe('formatSnapshot paging', () => {
  const many = (count: number): SnapshotResult => ({
    url: 'https://example.com',
    title: 'Example',
    time: 1,
    elements: Array.from({ length: count }, (_, i) => ({
      ref: i + 1,
      role: 'link',
      name: `Item ${i + 1}`,
      selector: `a[href='/item/${i + 1}']`,
      tag: 'a',
    })),
  });
  const shown = (output: string): number[] =>
    [...output.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));

  it('does not page unless the caller sets a budget', () => {
    const output = formatSnapshot(many(2000));

    expect(shown(output)).to.have.lengthOf(2000);
    expect(output).to.include('Snapshot: 2000 elements');
  });

  it('leaves a snapshot within the budget untouched', () => {
    const output = formatSnapshot(many(3), { maxChars: 2000 });

    expect(output).to.include('Snapshot: 3 elements');
    expect(output).to.not.include('more elements not shown');
    expect(shown(output)).to.deep.equal([1, 2, 3]);
  });

  it('stops at the budget and names the next page', () => {
    const output = formatSnapshot(many(100), { maxChars: 2000 });
    const refs = shown(output);
    const last = refs.at(-1) as number;

    expect(refs[0]).to.equal(1);
    expect(last).to.be.lessThan(100);
    expect(output.length).to.be.at.most(2000);
    expect(output).to.include(`Snapshot: elements 1-${last} of 100`);
    expect(output).to.include(`${100 - last} more elements not shown`);
    expect(output).to.include(
      `Next page: {"method":"snapshot","params":{"from":${last + 1}}}.`,
    );
    expect(output.trimEnd()).to.match(/--- END SNAPSHOT ---$/);
  });

  it('counts tab and frame context against the budget', () => {
    const snap = many(100);
    snap.activeTargetId = 'A';
    snap.tabs = ['A', 'B'].map((targetId) => ({
      targetId,
      title: 't'.repeat(300),
      url: `https://example.com/${'u'.repeat(300)}`,
      active: targetId === 'A',
    }));
    const output = formatSnapshot(snap, { maxChars: 3000 });

    expect(output.length).to.be.at.most(3000);
    expect(shown(output).length).to.be.greaterThan(0);
  });

  it('pages through every element exactly once', () => {
    const snap = many(100);
    const seen: number[] = [];
    let from: number | undefined = 1;
    while (from !== undefined) {
      const output = formatSnapshot(snap, { from, maxChars: 2000 });
      seen.push(...shown(output));
      const next = output.match(/"from":(\d+)/);
      from = next ? Number(next[1]) : undefined;
    }

    expect(seen).to.deep.equal(snap.elements.map((el) => el.ref));
  });

  it('reports the element range a page shows', () => {
    const page = pageSnapshot(many(100), { from: 11, maxChars: 2000 });

    expect(page.start).to.equal(10);
    expect(shown(page.text)).to.have.lengthOf(page.end - page.start);
    expect(shown(page.text)[0]).to.equal(11);
  });

  it('repeats the params that select the snapshot in the next-page call', () => {
    const output = formatSnapshot(many(100), {
      maxChars: 2000,
      carry: { targetId: 'TAB-B', maxElements: 1000 },
    });

    expect(output).to.match(
      /Next page: \{"method":"snapshot","params":\{"targetId":"TAB-B","maxElements":1000,"from":\d+\}\}\./,
    );
  });

  it('cuts only the tail of a line that is longer than the page', () => {
    const snap = many(3);
    snap.elements[0].options = Array.from({ length: 100 }, () =>
      'x'.repeat(80),
    );
    const output = formatSnapshot(snap, { maxChars: 2000 });
    const first = output.split('\n').find((l) => l.startsWith('[1] ')) ?? '';

    expect(output.length).to.be.at.most(2000);
    expect(first).to.include("ref=a[href='/item/1'] options=[xxx");
    expect(first.endsWith('… [line truncated]')).to.equal(true);
    expect(output).to.include('"from":2');
  });

  it('never cuts the name or selector, even when they alone exceed the page', () => {
    const snap = many(2);
    const selector = `a[href='/${'s'.repeat(600)}']`;
    snap.elements[0] = {
      ...snap.elements[0],
      name: 'n'.repeat(200),
      selector,
      value: 'v'.repeat(200),
    };
    const first =
      formatSnapshot(snap, { maxChars: 700 })
        .split('\n')
        .find((l) => l.startsWith('[1] ')) ?? '';

    expect(first).to.include(`"${'n'.repeat(200)}" ref=${selector} `);
    expect(first.endsWith('… [line truncated]')).to.equal(true);
  });

  it('diffs against only the elements a page showed', () => {
    const snap = many(10);
    const page = pageSnapshot(snap, { maxChars: 700 });
    expect(page.end).to.be.lessThan(10);
    const baseline = shownBaseline(snap, page);

    const diff = formatSnapshotDiff(snap, baseline);

    expect(baseline.size).to.equal(page.end);
    expect(diff).to.include(
      `Changes: ${10 - page.end} new, 0 changed, 0 removed, ${page.end} unchanged (10 total)`,
    );
    expect(diff).to.include('+ [10] a link "Item 10" ref=a[href=\'/item/10\']');
    expect(diff).to.not.include('+ [1] ');
  });

  it('does not count an element inserted between pages as shown', () => {
    const before = many(6);
    const first = shownBaseline(before, { start: 0, end: 3 });
    // A new element lands at position 0, shifting the rest down by one.
    const after: SnapshotResult = {
      ...before,
      elements: [
        {
          ref: 0,
          role: 'link',
          name: 'Inserted',
          selector: "a[href='/inserted']",
          tag: 'a',
        },
        ...before.elements,
      ],
    };
    // The follow-up page shows positions 4-5, i.e. Item 4 and Item 5.
    const baseline = shownBaseline(after, { start: 4, end: 6 }, first);

    expect([...baseline.values()].map((el) => el.name)).to.deep.equal([
      'Item 1',
      'Item 2',
      'Item 3',
      'Item 4',
      'Item 5',
    ]);
    expect(formatSnapshotDiff(after, baseline)).to.include(
      '+ [0] a link "Inserted"',
    );
  });

  it('keeps an earlier page in the state it was shown in', () => {
    const before = many(6);
    const first = shownBaseline(before, { start: 0, end: 3 });
    // Item 1 changes after page one was shown, before page two is requested.
    const after: SnapshotResult = {
      ...before,
      elements: before.elements.map((el, i) =>
        i === 0 ? { ...el, name: 'Item 1 (edited)' } : el,
      ),
    };
    const baseline = shownBaseline(after, { start: 3, end: 6 }, first);

    const diff = formatSnapshotDiff(after, baseline);

    expect(diff).to.include('1 changed');
    expect(diff).to.include('~ [1] a link "Item 1 (edited)"');
  });

  it('starts over when no earlier baseline is continued', () => {
    const snap = many(6);
    const baseline = shownBaseline(snap, { start: 3, end: 6 });

    expect([...baseline.values()].map((el) => el.ref)).to.deep.equal([4, 5, 6]);
  });

  it('adds the caller note after the next-page call', () => {
    const output = formatSnapshot(many(100), {
      maxChars: 2000,
      nextPageNote: 'Keep the browser first.',
    });

    expect(output).to.match(
      /"from":\d+\}\}\. Keep the browser first\. To read/,
    );
  });

  it('reports an empty page when from is past the end', () => {
    const output = formatSnapshot(many(3), { from: 10 });

    expect(shown(output)).to.deep.equal([]);
    expect(output).to.include('Snapshot: no elements at or after 10 (3 total)');
  });
});
