import { expect } from 'chai';
import { renderSkill } from '../../src/skills/index.js';

import {
  AGENT_SYSTEM_PROMPT,
  COMPLIANT_AGENT_SYSTEM_PROMPT,
} from '../../src/skills/system-prompt.js';

it('guides saved-login reporting only in the full Auth section', () => {
  const auth = AGENT_SYSTEM_PROMPT.split('## Auth')[1].split('\n## ')[0];
  for (const text of [
    'reportProfileAuthentication',
    'newLoginActivity',
    'authenticated',
    'login_required',
    'challenge',
    'unknown',
    'last command',
    'Never send it on sessions without',
    'session handle retains the profile',
    'before any login actions',
    'peek',
  ])
    expect(auth).to.include(text);
  expect(COMPLIANT_AGENT_SYSTEM_PROMPT).not.to.include(
    'reportProfileAuthentication',
  );
});

it('keeps profile reporting evidence and ordering explicit in login guidance', () => {
  expect(renderSkill('auth-profile', false)).to.include(
    'before any login actions',
  );
  for (const id of ['auth-profile', 'autonomous-login'] as const) {
    const skill = renderSkill(id, false);
    expect(skill).to.include('peek');
    expect(skill).to.include('signed-in element');
  }
  const login = renderSkill('autonomous-login', false);
  expect(login).to.include('"challenge"');
  expect(login).to.include('"unknown"');
  expect(login).not.to.include('when a signal held');
});

describe('outcome reporting guidance', () => {
  for (const [name, prompt] of [
    ['full', AGENT_SYSTEM_PROMPT],
    ['compliant', COMPLIANT_AGENT_SYSTEM_PROMPT],
  ]) {
    it(`asks the ${name} agent to report before close with bounded failure reasons`, () => {
      const ending = prompt
        .split('## Ending the session (REQUIRED)')[1]
        .split('\n## ')[0];
      for (const text of [
        'reportOutcome',
        'blocked_by_site',
        'captcha',
        'login_required',
        'timeout',
        'other',
        "**Report the outcome after you've seen the results.**",
        'which opens no browser',
      ]) {
        expect(ending).to.include(text);
      }
      expect(ending).not.to.include('**Report the outcome, then close.**');
      expect(ending).not.to.include('completed`');
    });
  }
  it('orders recipe reporting before task reporting and close', () => {
    const ending = AGENT_SYSTEM_PROMPT.split(
      '## Ending the session (REQUIRED)',
    )[1].split('\n## ')[0];
    expect(ending).to.include('reportSkillOutcome');
    expect(ending.indexOf('reportSkillOutcome')).to.be.lessThan(
      ending.indexOf("**Report the outcome after you've seen the results.**"),
    );
    expect(ending).to.include(
      'false if a step in this recipe failed as written',
    );
    expect(ending).to.include('even if you finished another way');
    expect(ending).to.include("Cosmetic differences that didn't break a step");
    expect(ending).to.include('failure_reason');
    expect(ending).to.include('site_changed');
    expect(AGENT_SYSTEM_PROMPT.split('## Site recipes')[1]).not.to.include(
      '**Report the outcome (only if',
    );
    expect(COMPLIANT_AGENT_SYSTEM_PROMPT).not.to.include('reportSkillOutcome');
    expect(AGENT_SYSTEM_PROMPT).to.include('Near the end of the run, send');
    expect(AGENT_SYSTEM_PROMPT).to.include(
      'Send it before `reportOutcome` and any `close`',
    );
    expect(AGENT_SYSTEM_PROMPT).not.to.include(
      'As your final command in the run',
    );
    expect(AGENT_SYSTEM_PROMPT).not.to.include(
      'Send it as your last command **before** any `close`',
    );
  });
});

it('describes bounded recipe failure reasons and agent-reported provenance', () => {
  for (const reason of [
    'authentication_required',
    'site_changed',
    'blocked',
    'timeout',
    'missing_data',
    'incorrect_result',
    'unknown',
  ]) {
    expect(AGENT_SYSTEM_PROMPT).to.include(reason);
  }
  expect(AGENT_SYSTEM_PROMPT).to.include('failure_reason');
  expect(AGENT_SYSTEM_PROMPT).to.include('agent-reported');
  expect(AGENT_SYSTEM_PROMPT).to.include('not independent validation');
  expect(AGENT_SYSTEM_PROMPT).to.include('omit');
});

describe('agent system prompt contextual snapshot guidance', () => {
  for (const [name, prompt] of [
    ['full', AGENT_SYSTEM_PROMPT],
    ['compliant', COMPLIANT_AGENT_SYSTEM_PROMPT],
  ] as const) {
    it(`teaches the ${name} agent one-shot and safe multi-step lifetimes`, () => {
      expect(prompt).to.include('one-shot by default');
      expect(prompt).to.match(/snapshot[^\n]+keepSessionAlive: true/);
      expect(prompt).to.match(/Unsure[^\n]+keepSessionAlive: true/);
      expect(prompt).to.include('FIRST call');
      expect(prompt).to.include('no need to repeat the flag');
    });

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
