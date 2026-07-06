import { expect } from 'chai';

import {
  formatSnapshotDiff,
  formatSnapshotDiffPositional,
  indexByIdentity,
} from '../../src/lib/agent-format.js';
import type {
  SnapshotElement,
  SnapshotResult,
} from '../../src/@types/types.js';

const el = (over: Partial<SnapshotElement>): SnapshotElement => ({
  ref: 0,
  role: 'button',
  name: '',
  selector: '',
  tag: 'button',
  ...over,
});

const snap = (
  elements: SnapshotElement[],
  extra: Partial<SnapshotResult> = {},
): SnapshotResult => ({
  url: 'https://example.com',
  title: 'Example',
  elements,
  time: 1,
  ...extra,
});

describe('formatSnapshotDiff', () => {
  it('omits unchanged elements and reports counts', () => {
    const prev = indexByIdentity(
      snap([
        el({ ref: 1, name: 'Home', selector: 'a#home' }),
        el({ ref: 2, name: 'Login', selector: 'a#login' }),
      ]),
    );
    // refs renumber, one unchanged, one new; identity is the selector.
    const out = formatSnapshotDiff(
      snap([
        el({ ref: 5, name: 'Home', selector: 'a#home' }),
        el({ ref: 6, name: 'Sign up', selector: 'a#signup' }),
      ]),
      prev,
    );
    expect(out).to.match(/1 new, 0 changed, 1 removed, 1 unchanged/);
    expect(out).to.include('+ [6] button button "Sign up" ref=a#signup');
    expect(out).to.include('- ref=a#login (removed)');
    expect(out).to.include('1 unchanged elements omitted');
    // Unchanged element must NOT be re-listed — that's the whole point.
    expect(out).to.not.include('"Home"');
  });

  it('preserves duplicate identity keys (removal of one is not hidden)', () => {
    // Two elements collapse to the same semantic key; removing one must show.
    const dup = { role: 'button', tag: 'button', name: 'Go', selector: '' };
    const prev = indexByIdentity(snap([el(dup), el(dup)]));
    const out = formatSnapshotDiff(snap([el(dup)]), prev);
    expect(out).to.match(/0 new, 0 changed, 1 removed/);
  });

  it('includes the frame legend in a diff when frames are present', () => {
    const frames = [
      { frameId: 'f1', url: 'https://ad.example', crossOrigin: true },
    ];
    const prev = indexByIdentity(snap([el({ selector: '#a', name: 'A' })]));
    const out = formatSnapshotDiff(
      snap(
        [
          el({ selector: '#a', name: 'A' }),
          el({ selector: '#b', name: 'B', frameId: 'f1' }),
        ],
        { frames },
      ),
      prev,
    );
    expect(out).to.include('Frames (1 iframes):');
    expect(out).to.include('frame#1 https://ad.example (cross-origin)');
  });

  it('flags an element whose state changed, ignoring ref renumbering', () => {
    const prev = indexByIdentity(
      snap([el({ ref: 1, selector: '#agree', name: 'Agree', checked: false })]),
    );
    const out = formatSnapshotDiff(
      snap([el({ ref: 9, selector: '#agree', name: 'Agree', checked: true })]),
      prev,
    );
    expect(out).to.match(/0 new, 1 changed, 0 removed, 0 unchanged/);
    expect(out).to.include('~ [9]');
    expect(out).to.include('(checked)');
  });

  it('reports no changes when nothing moved', () => {
    const prev = indexByIdentity(
      snap([el({ ref: 1, selector: '#x', name: 'X' })]),
    );
    const out = formatSnapshotDiff(
      snap([el({ ref: 2, selector: '#x', name: 'X' })]),
      prev,
    );
    expect(out).to.include('No changes since last snapshot.');
  });

  it('positional diff surfaces value changes when ids churn but order holds', () => {
    // In-place SPA re-render: stat tiles keep DOM order, ids churn, numbers move.
    const prev = [
      el({ ref: 1, role: 'text', name: '0', selector: 'div#radix-«r1»' }),
      el({ ref: 2, role: 'text', name: '5', selector: 'div#radix-«r2»' }),
    ];
    const out = formatSnapshotDiffPositional(
      prev,
      snap([
        el({ ref: 8, role: 'text', name: '1,158', selector: 'div#radix-«r7»' }),
        el({ ref: 9, role: 'text', name: '5', selector: 'div#radix-«r8»' }),
      ]),
    );
    expect(out).to.match(/1 changed, 1 unchanged/);
    expect(out).to.include('name: "0"→"1,158"');
    // Unchanged slot (value 5) must not be listed.
    expect(out).to.not.include('"5"');
  });

  it('treats a churned framework-id selector as the same element via semantic key', () => {
    // Radix/useId selectors regenerate per render on SPAs — semantic identity
    // (role+name+tag) must still match so it is not counted as new+removed.
    const prev = indexByIdentity(
      snap([
        el({
          ref: 1,
          role: 'menuitem',
          name: 'Profile',
          selector: 'div#radix-«r1»',
        }),
      ]),
    );
    const out = formatSnapshotDiff(
      snap([
        el({
          ref: 7,
          role: 'menuitem',
          name: 'Profile',
          selector: 'div#radix-«r9»',
        }),
      ]),
      prev,
    );
    expect(out).to.include('No changes since last snapshot.');
  });
});
