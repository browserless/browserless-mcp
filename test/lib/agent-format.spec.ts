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
