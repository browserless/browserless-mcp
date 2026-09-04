import { expect } from 'chai';
import { AgentParamsSchema } from '../../src/tools/agent.js';
import { FunctionParamsSchema } from '../../src/tools/function.js';
import {
  PERSONA_FIELDS,
  ProxyOptionsSchema,
  PROXY_FIELDS,
} from '../../src/lib/agent-client.js';

describe('ProxyOptionsSchema', () => {
  describe('proxyCountry', () => {
    it('normalizes uppercase ISO-2 to lowercase', () => {
      const parsed = ProxyOptionsSchema.parse({
        proxy: 'residential',
        proxyCountry: 'US',
      });
      expect(parsed.proxyCountry).to.equal('us');
    });

    it('accepts mixed case', () => {
      const parsed = ProxyOptionsSchema.parse({
        proxy: 'residential',
        proxyCountry: 'De',
      });
      expect(parsed.proxyCountry).to.equal('de');
    });

    it('rejects non-letter characters', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          proxy: 'residential',
          proxyCountry: 'u1',
        }),
      ).to.throw();
    });

    it('rejects length != 2', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          proxy: 'residential',
          proxyCountry: 'usa',
        }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({
          proxy: 'residential',
          proxyCountry: 'u',
        }),
      ).to.throw();
    });
  });

  describe('externalProxyServer', () => {
    it('accepts http:// upstreams', () => {
      const parsed = ProxyOptionsSchema.parse({
        externalProxyServer: 'http://user:pass@host:8080',
      });
      expect(parsed.externalProxyServer).to.equal('http://user:pass@host:8080');
    });

    it('accepts https:// upstreams', () => {
      const parsed = ProxyOptionsSchema.parse({
        externalProxyServer: 'https://proxy.example.com',
      });
      expect(parsed.externalProxyServer).to.equal('https://proxy.example.com');
    });

    it('rejects non-http schemes', () => {
      for (const v of [
        'ftp://host/',
        'javascript:alert(1)',
        'ws://host/',
        'file:///etc/passwd',
      ]) {
        expect(
          () => ProxyOptionsSchema.parse({ externalProxyServer: v }),
          `should reject ${v}`,
        ).to.throw();
      }
    });
  });

  describe('dependent-field refinement', () => {
    const tierCases: Array<[string, Record<string, unknown>, boolean]> = [
      ['residential preset', { proxy: 'residential', proxyPreset: 'px' }, true],
      ['datacenter geo', { proxy: 'datacenter', proxyCountry: 'us' }, true],
      ['datacenter sticky', { proxy: 'datacenter', proxySticky: true }, true],
      ['datacenter preset', { proxy: 'datacenter', proxyPreset: 'px' }, false],
      [
        'external preset',
        { externalProxyServer: 'http://host', proxyPreset: 'px' },
        false,
      ],
      ['orphan preset', { proxyPreset: 'px' }, false],
    ];

    for (const [name, value, accepted] of tierCases) {
      it(`${accepted ? 'accepts' : 'rejects'} ${name}`, () => {
        expect(ProxyOptionsSchema.safeParse(value).success).to.equal(accepted);
      });
    }

    it('accepts an empty object', () => {
      expect(() => ProxyOptionsSchema.parse({})).to.not.throw();
    });

    it('accepts proxy alone', () => {
      expect(() =>
        ProxyOptionsSchema.parse({ proxy: 'residential' }),
      ).to.not.throw();
    });

    it('accepts datacenter with geo and sticky fields', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          proxy: 'datacenter',
          proxyCountry: 'us',
          proxySticky: true,
        }),
      ).to.not.throw();
    });

    it('accepts externalProxyServer alone', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          externalProxyServer: 'http://host/',
        }),
      ).to.not.throw();
    });

    it('accepts proxy + geo fields', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          proxy: 'residential',
          proxyCountry: 'us',
          proxySticky: true,
        }),
      ).to.not.throw();
    });

    it('accepts externalProxyServer + geo fields', () => {
      expect(() =>
        ProxyOptionsSchema.parse({
          externalProxyServer: 'http://host/',
          proxyCountry: 'us',
        }),
      ).to.not.throw();
    });

    it('rejects geo field without proxy or externalProxyServer', () => {
      expect(() => ProxyOptionsSchema.parse({ proxyCountry: 'us' })).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyState: 'new_york' }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyCity: 'denver' }),
      ).to.throw();
      expect(() => ProxyOptionsSchema.parse({ proxySticky: true })).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyLocaleMatch: true }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyPreset: 'px_amazon01' }),
      ).to.throw();
    });
  });

  describe('PROXY_FIELDS', () => {
    it('exposes every field declared on the schema', () => {
      expect(PROXY_FIELDS).to.have.members([
        'proxy',
        'proxyCountry',
        'proxyState',
        'proxyCity',
        'proxySticky',
        'proxyLocaleMatch',
        'proxyPreset',
        'externalProxyServer',
      ]);
    });
  });
});

describe('AgentParamsSchema.proxy', () => {
  it('passes a valid proxy object through unchanged (case-normalized)', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
      proxy: {
        proxy: 'residential',
        proxyCountry: 'US',
        proxySticky: true,
      },
    });
    expect(parsed.proxy).to.deep.equal({
      proxy: 'residential',
      proxyCountry: 'us',
      proxySticky: true,
    });
  });

  it('accepts omitted proxy', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
    });
    expect(parsed.proxy).to.be.undefined;
  });
});

describe('AgentParamsSchema persona', () => {
  it('accepts every persona option on the top-level Agent surface', () => {
    const desktop = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
      emulationOs: 'windows',
      screen: '1920x1080',
      deviceScaleFactor: 1.25,
      deviceSlot: 3,
    });
    const android = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
      emulationOs: 'android',
      emulatedDevice: 'pixel-8',
    });
    expect(desktop.deviceSlot).to.equal(3);
    expect(android.emulatedDevice).to.equal('pixel-8');
    expect(PERSONA_FIELDS).to.have.members([
      'emulationOs',
      'emulatedDevice',
      'screen',
      'deviceScaleFactor',
      'deviceSlot',
    ]);
  });

  it('normalizes surrounding whitespace in a desktop screen', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'snapshot',
      emulationOs: 'windows',
      screen: ' 1920x1080 ',
    });

    expect(parsed.screen).to.equal('1920x1080');
  });

  it('enforces device and slot persona relationships locally', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      [
        'Android device',
        { emulationOs: 'android', emulatedDevice: 'pixel-8' },
        true,
      ],
      ['device without OS', { emulatedDevice: 'pixel-8' }, false],
      [
        'device on desktop',
        { emulationOs: 'windows', emulatedDevice: 'pixel-8' },
        false,
      ],
      ['desktop slot', { emulationOs: 'windows', deviceSlot: 2 }, true],
      ['slot without OS', { deviceSlot: 2 }, false],
      ['slot on Android', { emulationOs: 'android', deviceSlot: 2 }, false],
      ['desktop screen', { emulationOs: 'windows', screen: '1920x1080' }, true],
      [
        'desktop screen with OS alias',
        { os: 'windows', screen: '1920x1080' },
        true,
      ],
      [
        'malformed desktop screen',
        { emulationOs: 'windows', screen: 'wide' },
        false,
      ],
      [
        'undersized desktop screen',
        { emulationOs: 'windows', screen: '320x200' },
        false,
      ],
      [
        'oversized desktop screen',
        { emulationOs: 'windows', screen: '8000x8000' },
        false,
      ],
      ['screen without OS', { screen: '1920x1080' }, false],
      [
        'screen on Android',
        { emulationOs: 'android', screen: '1920x1080' },
        false,
      ],
      [
        'desktop screen with DPR',
        {
          emulationOs: 'windows',
          screen: '1920x1080',
          deviceScaleFactor: 1.25,
        },
        true,
      ],
      [
        'DPR without screen',
        { emulationOs: 'windows', deviceScaleFactor: 1.25 },
        false,
      ],
      [
        'DPR without OS',
        { screen: '1920x1080', deviceScaleFactor: 1.25 },
        false,
      ],
    ];
    for (const [name, extra, accepted] of cases) {
      expect(
        AgentParamsSchema.safeParse({ method: 'snapshot', ...extra }).success,
        name,
      ).to.equal(accepted);
    }
  });

  it('rejects unknown operating systems, DPRs, and invalid slots', () => {
    for (const extra of [
      { emulationOs: 'plan9' },
      { deviceScaleFactor: 2 },
      { deviceSlot: -1 },
      { deviceSlot: 1.5 },
    ]) {
      expect(() =>
        AgentParamsSchema.parse({
          method: 'goto',
          params: { url: 'https://example.com' },
          ...extra,
        }),
      ).to.throw();
    }
  });

  it('enforces the persona creation relationship matrix', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['persona launch', { emulationOs: 'windows' }, true],
      ['profile creation', { createProfile: { name: 'demo' } }, true],
      [
        'profile creation with OS alias',
        { createProfile: { name: 'demo' }, emulationOs: 'windows' },
        true,
      ],
      [
        'profile creation with additional persona state',
        {
          createProfile: { name: 'demo' },
          emulationOs: 'windows',
          screen: '1920x1080',
        },
        false,
      ],
    ];
    for (const [name, extra, accepted] of cases) {
      expect(
        AgentParamsSchema.safeParse({
          commands: [
            { method: 'goto', params: { url: 'https://example.com' } },
          ],
          ...extra,
        }).success,
        name,
      ).to.equal(accepted);
    }
  });

  it('accepts matching OS aliases and rejects conflicting aliases', () => {
    expect(
      AgentParamsSchema.safeParse({
        method: 'snapshot',
        os: 'windows',
        emulationOs: 'windows',
      }).success,
    ).to.equal(true);
    expect(
      AgentParamsSchema.safeParse({
        method: 'snapshot',
        os: 'macos',
        emulationOs: 'windows',
      }).success,
    ).to.equal(false);
  });
});

describe('AgentParamsSchema recording batches', () => {
  it('rejects recording during profile creation', () => {
    expect(
      AgentParamsSchema.safeParse({
        createProfile: { name: 'demo' },
        record: true,
        method: 'snapshot',
      }).success,
    ).to.equal(false);
    expect(
      AgentParamsSchema.safeParse({
        createProfile: { name: 'demo' },
        record: false,
        method: 'snapshot',
      }).success,
    ).to.equal(true);
  });

  it('requires stopRecording to be final except before close', () => {
    expect(
      AgentParamsSchema.safeParse({
        commands: [
          { method: 'stopRecording', params: {} },
          { method: 'snapshot', params: {} },
        ],
      }).success,
    ).to.equal(false);
    expect(
      AgentParamsSchema.safeParse({
        commands: [
          { method: 'stopRecording', params: {} },
          { method: 'close', params: {} },
        ],
      }).success,
    ).to.equal(true);
  });
});

// The shared `profileField` helper refines profile names to reject NUL
// characters — the session-key separator in agent-client.ts is '\u0000',
// so a profile containing NUL could collide with another key. These tests
// lock that refinement in across any schema that uses profileField.
describe('profile field (shared profileField helper)', () => {
  it('accepts a normal profile name', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
      profile: 'user123',
    });
    expect(parsed.profile).to.equal('user123');
  });

  it('accepts a profile name omitted', () => {
    const parsed = FunctionParamsSchema.parse({ code: 'x' });
    expect(parsed.profile).to.be.undefined;
  });

  it('rejects a profile name containing NUL (agent schema)', () => {
    const result = AgentParamsSchema.safeParse({
      method: 'goto',
      params: { url: 'https://example.com' },
      profile: 'bad\u0000name',
    });
    expect(result.success).to.equal(false);
  });

  it('rejects a profile name containing NUL (function schema)', () => {
    const result = FunctionParamsSchema.safeParse({
      code: 'x',
      profile: 'bad\u0000name',
    });
    expect(result.success).to.equal(false);
  });

  it('rejects an empty profile name', () => {
    const result = FunctionParamsSchema.safeParse({
      code: 'x',
      profile: '',
    });
    expect(result.success).to.equal(false);
  });

  it('trims surrounding whitespace from a profile name', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'goto',
      params: { url: 'https://example.com' },
      profile: '  my-login  ',
    });
    expect(parsed.profile).to.equal('my-login');
  });

  it('rejects a whitespace-only profile name', () => {
    // After .trim() a whitespace-only value is empty, so .min(1) rejects it.
    const result = AgentParamsSchema.safeParse({
      method: 'goto',
      params: { url: 'https://example.com' },
      profile: '   ',
    });
    expect(result.success).to.equal(false);
  });
});

describe('loadSecret command', () => {
  it('accepts a loadSecret command with ref + selector', () => {
    const parsed = AgentParamsSchema.parse({
      commands: [
        {
          method: 'loadSecret',
          params: {
            ref: 'op://Automation/imdb/password',
            selector: 'input#ap_password',
          },
        },
      ],
    });
    const cmd = parsed.commands?.[0];
    expect(cmd?.method).to.equal('loadSecret');
    expect((cmd?.params as { ref?: string })?.ref).to.equal(
      'op://Automation/imdb/password',
    );
  });

  it('accepts a loadSecret command with ref only (selector optional)', () => {
    const result = AgentParamsSchema.safeParse({
      commands: [
        {
          method: 'loadSecret',
          params: { ref: 'op://Automation/imdb/username' },
        },
      ],
    });
    expect(result.success).to.equal(true);
  });

  it('rejects a loadSecret command missing ref', () => {
    const result = AgentParamsSchema.safeParse({
      commands: [
        { method: 'loadSecret', params: { selector: 'input#ap_email' } },
      ],
    });
    expect(result.success).to.equal(false);
  });
});

describe('createProfile field', () => {
  it('accepts a createProfile object on its own', () => {
    const parsed = AgentParamsSchema.parse({
      createProfile: { name: 'github' },
      commands: [
        { method: 'goto', params: { url: 'https://github.com/login' } },
      ],
    });
    expect(parsed.createProfile?.name).to.equal('github');
  });

  it('rejects createProfile and profile together (mutually exclusive)', () => {
    const result = AgentParamsSchema.safeParse({
      profile: 'github',
      createProfile: { name: 'github' },
    });
    expect(result.success).to.equal(false);
  });

  it('rejects a createProfile name containing whitespace, /, ?, or #', () => {
    for (const name of ['has space', 'a/b', 'a?b', 'a#b']) {
      const result = AgentParamsSchema.safeParse({ createProfile: { name } });
      expect(result.success, name).to.equal(false);
    }
  });
});

describe('AgentParamsSchema click coordinates', () => {
  const parseClick = (params: Record<string, unknown>): boolean =>
    AgentParamsSchema.safeParse({
      rationale: 'test',
      commands: [{ method: 'click', params }],
    }).success;

  it('accepts a selector alone', () => {
    expect(parseClick({ selector: 'button#go' })).to.equal(true);
  });

  it('accepts both x and y without a selector', () => {
    expect(parseClick({ x: 10, y: 20 })).to.equal(true);
  });

  it('rejects x without y', () => {
    expect(parseClick({ x: 10 })).to.equal(false);
  });

  it('rejects a selector combined with a coordinate', () => {
    expect(parseClick({ selector: 'button#go', x: 10 })).to.equal(false);
    expect(parseClick({ selector: 'button#go', x: 10, y: 20 })).to.equal(false);
  });

  it('rejects an empty params object', () => {
    expect(parseClick({})).to.equal(false);
  });
});
