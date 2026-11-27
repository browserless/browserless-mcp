import { expect } from 'chai';

import { formatSnapshot } from '../../src/lib/agent-format.js';
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
    const output = formatSnapshot(many(3), { maxChars: 400 });

    expect(output).to.include('Snapshot: 3 elements');
    expect(output).to.not.include('more elements not shown');
    expect(shown(output)).to.deep.equal([1, 2, 3]);
  });

  it('stops at the budget and names the next page', () => {
    const output = formatSnapshot(many(100), { maxChars: 400 });
    const refs = shown(output);
    const last = refs.at(-1) as number;

    expect(refs[0]).to.equal(1);
    expect(last).to.be.lessThan(100);
    expect(output).to.include(`Snapshot: elements 1-${last} of 100`);
    expect(output).to.include(`${100 - last} more elements not shown`);
    expect(output).to.include(
      `Next page: {"method":"snapshot","params":{"from":${last + 1}}}.`,
    );
    expect(output.trimEnd()).to.match(/--- END SNAPSHOT ---$/);
  });

  it('pages through every element exactly once', () => {
    const snap = many(100);
    const seen: number[] = [];
    let from: number | undefined = 1;
    while (from !== undefined) {
      const output = formatSnapshot(snap, { from, maxChars: 400 });
      seen.push(...shown(output));
      const next = output.match(/"from":(\d+)/);
      from = next ? Number(next[1]) : undefined;
    }

    expect(seen).to.deep.equal(snap.elements.map((el) => el.ref));
  });

  it('repeats the params that select the snapshot in the next-page call', () => {
    const output = formatSnapshot(many(100), {
      maxChars: 400,
      carry: { targetId: 'TAB-B', maxElements: 1000 },
    });

    expect(output).to.match(
      /Next page: \{"method":"snapshot","params":\{"targetId":"TAB-B","maxElements":1000,"from":\d+\}\}\./,
    );
  });

  it('cuts a single line that is longer than the page, keeping its ref', () => {
    const snap = many(3);
    snap.elements[0].options = Array.from({ length: 100 }, () =>
      'x'.repeat(80),
    );
    const output = formatSnapshot(snap, { maxChars: 400 });
    const first = output.split('\n').find((l) => l.startsWith('[1] ')) ?? '';

    expect(first).to.have.lengthOf(400);
    expect(first).to.include("ref=a[href='/item/1']");
    expect(first.endsWith('… [line truncated]')).to.equal(true);
    expect(output).to.include('"from":2');
  });

  it('reports an empty page when from is past the end', () => {
    const output = formatSnapshot(many(3), { from: 10 });

    expect(shown(output)).to.deep.equal([]);
    expect(output).to.include('Snapshot: no elements at or after 10 (3 total)');
  });
});
