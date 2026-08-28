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
});

describe('full Agent persona and proxy guidance', () => {
  it('names the persona contract, timing, block signals, and proxy trade-off', () => {
    for (const field of [
      'emulationOs',
      'emulatedDevice',
      'screen',
      'deviceScaleFactor',
      'deviceSlot',
    ]) {
      expect(AGENT_SYSTEM_PROMPT).to.include(field);
    }
    for (const personaOnlyField of [
      'emulationOs',
      'emulatedDevice',
      'deviceScaleFactor',
      'deviceSlot',
    ]) {
      expect(COMPLIANT_AGENT_SYSTEM_PROMPT).to.not.include(personaOnlyField);
    }
    expect(AGENT_SYSTEM_PROMPT).to.match(/very first call|first call/i);
    expect(AGENT_SYSTEM_PROMPT).to.match(/Cloudflare|hard block/i);
    expect(AGENT_SYSTEM_PROMPT).to.match(/datacenter/i);
    expect(AGENT_SYSTEM_PROMPT).to.match(/lower-cost/i);
    expect(AGENT_SYSTEM_PROMPT).to.match(/residential.*block/i);
  });
});
