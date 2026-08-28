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

  it('guides full-mode agents through SPA capture recovery after loadSecret', () => {
    expect(AGENT_SYSTEM_PROMPT).to.include('clearSecrets');
    expect(AGENT_SYSTEM_PROMPT).to.include('single-page app');
    expect(AGENT_SYSTEM_PROMPT).to.include('CaptureBlockedError');
    expect(AGENT_SYSTEM_PROMPT).to.include('screenshot');
    expect(AGENT_SYSTEM_PROMPT).to.include('liveURL');
    expect(AGENT_SYSTEM_PROMPT).to.include('PDF');
  });

  it('does not advertise clearSecrets on the compliant surface', () => {
    expect(COMPLIANT_AGENT_SYSTEM_PROMPT).to.not.include('clearSecrets');
  });
});
