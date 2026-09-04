import { expect } from 'chai';

import {
  AGENT_SYSTEM_PROMPT,
  COMPLIANT_AGENT_SYSTEM_PROMPT,
} from '../../src/skills/system-prompt.js';

describe('agent system prompt contextual snapshot guidance', () => {
  for (const [name, prompt] of [
    ['full', AGENT_SYSTEM_PROMPT],
    ['compliant', COMPLIANT_AGENT_SYSTEM_PROMPT],
  ] as const) {
    it(`keeps the ${name} prompt aware of context and destructive controls`, () => {
      expect(prompt).to.include('desc="..."');
      expect(prompt).to.include('action=METHOD URL');
      expect(prompt).to.include('autocomplete=...');
      expect(prompt).to.include('⚠ destructive');
      expect(prompt).to.include('⚠ sign-out');
      expect(prompt).to.include(
        'Before activating or navigating to a control marked',
      );
      expect(prompt).to.not.include('Before clicking a control marked');
      expect(prompt).to.include('confirm that the action is actually intended');
      expect(prompt).to.include(
        'an unlabeled destructive control is a common trap',
      );
    });
  }

  it('documents proxy options inside the top-level proxy object', () => {
    expect(AGENT_SYSTEM_PROMPT).to.include(
      '`{ "proxy": { "proxy": "residential", "proxyCountry": "us" } }`',
    );
    expect(AGENT_SYSTEM_PROMPT).to.include('fields belong inside that object');
  });
});
