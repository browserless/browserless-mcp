import { expect } from 'chai';
import {
  createSkillState,
  detectSkills,
  isCloudApi,
  markFired,
  renderSkill,
  renderSkills,
  skillsRegistry,
} from '../../src/skills/index.js';
import type {
  SnapshotElement,
  SnapshotResult,
} from '../../src/lib/agent-client.js';

const el = (overrides: Partial<SnapshotElement>): SnapshotElement => ({
  ref: 1,
  role: 'button',
  name: '',
  selector: 'button',
  tag: 'button',
  ...overrides,
});

const snapshot = (
  elements: SnapshotElement[],
  url = 'https://example.com',
): SnapshotResult => ({
  url,
  title: 'Example',
  elements,
  time: 0,
});

const CLOUD = 'https://production.browserless.io';
const SELF_HOSTED = 'https://browserless.example.com';

describe('skills/registry', () => {
  it('loads all six skill bodies', () => {
    expect(skillsRegistry).to.have.lengthOf(6);
    const ids = skillsRegistry.map((s) => s.id);
    expect(ids).to.have.members([
      'shadow-dom',
      'cookie-consent',
      'modals',
      'captchas',
      'snapshot-misses',
      'dynamic-content',
    ]);
    for (const skill of skillsRegistry) {
      expect(skill.body, `${skill.id} body`).to.be.a('string').and.not.empty;
      expect(skill.body.length, `${skill.id} body length`).to.be.greaterThan(
        100,
      );
    }
  });

  it('renderSkill wraps body with markers and the file path', () => {
    const out = renderSkill('shadow-dom');
    expect(out).to.match(
      /^--- SKILL: shadow-dom \(src\/skills\/shadow-dom\.md\) ---/,
    );
    expect(out).to.match(/--- END SKILL ---$/);
  });

  it('renderSkills joins multiple', () => {
    const out = renderSkills(['shadow-dom', 'modals']);
    expect(out).to.include('SKILL: shadow-dom');
    expect(out).to.include('SKILL: modals');
  });
});

describe('skills/isCloudApi', () => {
  it('returns true for production cloud hostnames', () => {
    expect(isCloudApi('https://production.browserless.io')).to.be.true;
    expect(isCloudApi('https://chrome.browserless.io')).to.be.true;
  });

  it('returns false for self-hosted and bad input', () => {
    expect(isCloudApi('https://browserless.example.com')).to.be.false;
    expect(isCloudApi(undefined)).to.be.false;
    expect(isCloudApi('not-a-url')).to.be.false;
  });
});

describe('skills/detectSkills - shadow-dom', () => {
  it('fires when the snapshot contains a deep-ref selector', () => {
    const state = createSkillState();
    const ctx = {
      snapshot: snapshot([el({ selector: '< button#deny', name: 'Deny' })]),
    };
    expect(detectSkills(ctx, state)).to.include('shadow-dom');
  });

  it('does not fire on a snapshot with only normal selectors', () => {
    const state = createSkillState();
    const ctx = {
      snapshot: snapshot([el({ selector: 'button#go', name: 'Go' })]),
    };
    expect(detectSkills(ctx, state)).to.not.include('shadow-dom');
  });

  it('fires on SELECTOR_NOT_FOUND for a non-deep selector', () => {
    const state = createSkillState();
    const ctx = {
      error: { code: 'SELECTOR_NOT_FOUND', message: 'no such element' },
      cmd: { method: 'click', params: { selector: 'button#missing' } },
    };
    expect(detectSkills(ctx, state)).to.include('shadow-dom');
  });

  it('does not fire on SELECTOR_NOT_FOUND when the selector is already deep', () => {
    const state = createSkillState();
    const ctx = {
      error: { code: 'SELECTOR_NOT_FOUND', message: 'no such element' },
      cmd: { method: 'click', params: { selector: '< button#missing' } },
    };
    expect(detectSkills(ctx, state)).to.not.include('shadow-dom');
  });
});

describe('skills/detectSkills - cookie-consent', () => {
  it('fires when a button name matches the consent regex', () => {
    const state = createSkillState();
    for (const name of ['Accept all', 'Reject all', 'Cookie settings', 'Consent']) {
      const ctx = { snapshot: snapshot([el({ role: 'button', name })]) };
      expect(detectSkills(ctx, createSkillState()), name).to.include(
        'cookie-consent',
      );
    }
    expect(state.fired.size).to.equal(0);
  });

  it('does not fire on an unrelated button', () => {
    const ctx = {
      snapshot: snapshot([el({ role: 'button', name: 'Submit' })]),
    };
    expect(detectSkills(ctx, createSkillState())).to.not.include(
      'cookie-consent',
    );
  });
});

describe('skills/detectSkills - modals', () => {
  it('fires when an element has role dialog', () => {
    const ctx = {
      snapshot: snapshot([el({ role: 'dialog', name: 'Sign in' })]),
    };
    expect(detectSkills(ctx, createSkillState())).to.include('modals');
  });

  it('fires when an element has role alertdialog', () => {
    const ctx = {
      snapshot: snapshot([el({ role: 'alertdialog', name: 'Confirm delete' })]),
    };
    expect(detectSkills(ctx, createSkillState())).to.include('modals');
  });

  it('does not fire when no dialog is present', () => {
    const ctx = { snapshot: snapshot([el({ role: 'button', name: 'OK' })]) };
    expect(detectSkills(ctx, createSkillState())).to.not.include('modals');
  });
});

describe('skills/detectSkills - captchas', () => {
  it('fires on a Cloudflare challenge URL when on cloud', () => {
    const ctx = {
      snapshot: snapshot([], 'https://challenges.cloudflare.com/foo'),
      apiUrl: CLOUD,
    };
    expect(detectSkills(ctx, createSkillState())).to.include('captchas');
  });

  it('fires on captcha-related element text', () => {
    const ctx = {
      snapshot: snapshot([
        el({ role: 'heading', name: "Verify you are human" }),
      ]),
      apiUrl: CLOUD,
    };
    expect(detectSkills(ctx, createSkillState())).to.include('captchas');
  });

  it('fires on a 403 response from goto', () => {
    const ctx = {
      cmd: { method: 'goto', params: { url: 'https://example.com' } },
      error: { message: 'Navigation blocked: 403 Forbidden by Cloudflare' },
      apiUrl: CLOUD,
    };
    expect(detectSkills(ctx, createSkillState())).to.include('captchas');
  });

  it('does NOT fire on self-hosted (cloud-only gate)', () => {
    const ctx = {
      snapshot: snapshot([], 'https://challenges.cloudflare.com/foo'),
      apiUrl: SELF_HOSTED,
    };
    expect(detectSkills(ctx, createSkillState())).to.not.include('captchas');
  });
});

describe('skills/detectSkills - snapshot-misses', () => {
  it('fires when the snapshot hits the default 500-element cap', () => {
    const elements = Array.from({ length: 500 }, (_, i) =>
      el({ ref: i, selector: `button#${i}`, name: `b${i}` }),
    );
    const ctx = {
      snapshot: snapshot(elements),
      cmd: { method: 'snapshot', params: {} },
    };
    expect(detectSkills(ctx, createSkillState())).to.include(
      'snapshot-misses',
    );
  });

  it('fires when the snapshot is empty', () => {
    const ctx = {
      snapshot: snapshot([]),
      cmd: { method: 'snapshot', params: {} },
    };
    expect(detectSkills(ctx, createSkillState())).to.include(
      'snapshot-misses',
    );
  });

  it('respects a higher requested maxElements (only fires when full)', () => {
    const ctx750NotFull = {
      snapshot: snapshot(
        Array.from({ length: 600 }, (_, i) => el({ ref: i, selector: `b${i}` })),
      ),
      cmd: { method: 'snapshot', params: { maxElements: 1000 } },
    };
    expect(detectSkills(ctx750NotFull, createSkillState())).to.not.include(
      'snapshot-misses',
    );

    const ctx1000Full = {
      snapshot: snapshot(
        Array.from({ length: 1000 }, (_, i) => el({ ref: i, selector: `b${i}` })),
      ),
      cmd: { method: 'snapshot', params: { maxElements: 1000 } },
    };
    expect(detectSkills(ctx1000Full, createSkillState())).to.include(
      'snapshot-misses',
    );
  });

  it('does not fire on a normal small snapshot', () => {
    const ctx = {
      snapshot: snapshot([el({ ref: 0, selector: 'button' })]),
      cmd: { method: 'snapshot', params: {} },
    };
    expect(detectSkills(ctx, createSkillState())).to.not.include(
      'snapshot-misses',
    );
  });
});

describe('skills/detectSkills - dynamic-content', () => {
  it('fires when waitForSelector times out', () => {
    const ctx = {
      cmd: {
        method: 'waitForSelector',
        params: { selector: '.results', timeout: 5000 },
      },
      error: { message: 'waiting for selector ".results" failed: timeout 5000ms exceeded' },
    };
    expect(detectSkills(ctx, createSkillState())).to.include(
      'dynamic-content',
    );
  });

  it('fires when waitForResponse times out', () => {
    const ctx = {
      cmd: { method: 'waitForResponse', params: { url: '*api/x*' } },
      error: { message: 'Timed out after 30000ms' },
    };
    expect(detectSkills(ctx, createSkillState())).to.include(
      'dynamic-content',
    );
  });

  it('does not fire on a non-wait command timing out', () => {
    const ctx = {
      cmd: { method: 'click', params: { selector: 'button#x' } },
      error: { message: 'click failed: timeout 30000ms' },
    };
    expect(detectSkills(ctx, createSkillState())).to.not.include(
      'dynamic-content',
    );
  });

  it('does not fire on a non-timeout wait error', () => {
    const ctx = {
      cmd: { method: 'waitForSelector', params: { selector: '.x' } },
      error: { code: 'INVALID_SELECTOR', message: 'malformed selector' },
    };
    expect(detectSkills(ctx, createSkillState())).to.not.include(
      'dynamic-content',
    );
  });
});

describe('skills/detectSkills - once-per-session and re-fire', () => {
  it('does not re-fire a non-refire skill', () => {
    const state = createSkillState();
    const ctx = {
      snapshot: snapshot([el({ role: 'dialog', name: 'Sign in' })]),
    };
    state.cmdIndex = 1;
    let triggered = detectSkills(ctx, state);
    expect(triggered).to.include('modals');
    markFired(state, triggered);

    state.cmdIndex = 10;
    triggered = detectSkills(ctx, state);
    expect(triggered).to.not.include('modals');
  });

  it('re-fires shadow-dom after 3+ commands have elapsed', () => {
    const state = createSkillState();
    const ctx = {
      snapshot: snapshot([el({ selector: '< button#x', name: 'x' })]),
    };
    state.cmdIndex = 1;
    let triggered = detectSkills(ctx, state);
    expect(triggered).to.include('shadow-dom');
    markFired(state, triggered);

    state.cmdIndex = 3;
    triggered = detectSkills(ctx, state);
    expect(triggered).to.not.include('shadow-dom');

    state.cmdIndex = 4;
    triggered = detectSkills(ctx, state);
    expect(triggered).to.include('shadow-dom');
  });

  it('re-fires captchas after 3+ commands when still on cloud', () => {
    const state = createSkillState();
    const ctx = {
      snapshot: snapshot([], 'https://challenges.cloudflare.com/foo'),
      apiUrl: CLOUD,
    };
    state.cmdIndex = 1;
    markFired(state, detectSkills(ctx, state));

    state.cmdIndex = 5;
    expect(detectSkills(ctx, state)).to.include('captchas');
  });
});
