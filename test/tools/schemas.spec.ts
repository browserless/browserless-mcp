import { expect } from 'chai';
import {
  AgentCommandSchema,
  AgentToolParamsSchema,
  CompliantAgentCommandSchema,
} from '../../src/tools/schemas.js';
import { AgentParamsSchema } from '../../src/tools/agent.js';
import { FunctionParamsSchema } from '../../src/tools/function.js';
import {
  PERSONA_FIELDS,
  ProxyOptionsSchema,
  PROXY_FIELDS,
} from '../../src/lib/agent-client.js';

describe('reportSkillOutcome schema', () => {
  it('preserves legacy reports, each bounded reason and attribution metadata', () => {
    for (const failure_reason of [
      undefined,
      'authentication_required',
      'site_changed',
      'blocked',
      'timeout',
      'missing_data',
      'incorrect_result',
      'unknown',
    ]) {
      const command = {
        method: 'reportSkillOutcome',
        params: {
          domain: 'example.com',
          task: 'search',
          success: false,
          ...(failure_reason ? { failure_reason } : {}),
          run_id: 'a'.repeat(64),
          skill_use_id: 'b'.repeat(64),
          loaded_version: 3,
        },
      };
      expect(AgentCommandSchema.parse(command)).to.deep.equal(command);
    }
    expect(
      AgentCommandSchema.safeParse({
        method: 'reportSkillOutcome',
        params: { domain: 'example.com', task: 'search', success: true },
      }).success,
    ).to.equal(true);
  });

  it('rejects malformed reports without falling through to generic commands', () => {
    for (const changes of [
      { failure_reason: null },
      { failure_reason: 1 },
      { failure_reason: {} },
      { failure_reason: 'https://private.example/?token=secret' },
      { success: true, failure_reason: 'timeout' },
      { success: 'false' },
      { domain: 1 },
      { task: {} },
      { domain: '' },
      { task: '' },
    ]) {
      expect(
        AgentCommandSchema.safeParse({
          method: 'reportSkillOutcome',
          params: {
            domain: 'example.com',
            task: 'search',
            success: false,
            ...changes,
          },
        }).success,
        JSON.stringify(changes),
      ).to.equal(false);
    }
  });
});

for (const [name, schema] of [
  ['AgentCommandSchema', AgentCommandSchema],
  ['CompliantAgentCommandSchema', CompliantAgentCommandSchema],
] as const) {
  describe(`${name} reportOutcome`, () => {
    it('accepts boolean verdicts and each fixed reason', () => {
      for (const success of [true, false]) {
        for (const reason of [
          undefined,
          'completed',
          'blocked_by_site',
          'captcha',
          'login_required',
          'timeout',
          'other',
        ]) {
          const command = {
            method: 'reportOutcome',
            params: { success, ...(reason ? { reason } : {}) },
          };
          expect(schema.parse(command)).to.deep.equal(command);
        }
      }
    });

    it('rejects malformed verdicts rather than using generic passthrough', () => {
      for (const params of [
        {},
        { success: 'yes' },
        { success: 1 },
        { success: true, reason: 'https://example.com?token=secret' },
      ]) {
        expect(
          schema.safeParse({ method: 'reportOutcome', params }).success,
        ).to.equal(false);
      }
    });
  });

  describe(`${name} navigation URLs`, () => {
    it('preserves HTTP and HTTPS URLs for navigation and new tabs', () => {
      for (const method of ['goto', 'createTab'] as const) {
        for (const url of ['http://example.com', 'https://example.com']) {
          expect(schema.parse({ method, params: { url } })).to.deep.equal({
            method,
            params: { url },
          });
        }
      }
    });

    it('rejects unsupported schemes and malformed goto URLs', () => {
      for (const url of [
        'file:///etc/passwd',
        'chrome://settings',
        'javascript:alert(1)',
        'ftp://host/',
        'ws://host/',
        'about:blank',
        'data:text/html,x',
        '//example.com',
        'not a url',
        '',
        '   ',
        'https://[',
      ]) {
        expect(
          schema.safeParse({ method: 'goto', params: { url } }).success,
          `should reject ${JSON.stringify(url)}`,
        ).to.equal(false);
      }
    });

    it('reports the expected schemes without echoing the rejected URL', () => {
      const result = schema.safeParse({
        method: 'goto',
        params: { url: 'file:///etc/passwd' },
      });
      expect(result.success).to.equal(false);
      if (!result.success) {
        // The extensible command union nests typed-command validation errors.
        expect(result.error.message).to.include(
          'url must be an http:// or https:// URL',
        );
        expect(result.error.message).not.to.include('file:///etc/passwd');
      }
    });

    it('preserves explicit about:blank and omitted new-tab URLs', () => {
      expect(
        schema.parse({ method: 'createTab', params: { url: 'about:blank' } }),
      ).to.deep.equal({ method: 'createTab', params: { url: 'about:blank' } });
      expect(schema.parse({ method: 'createTab', params: {} })).to.deep.equal({
        method: 'createTab',
        params: {},
      });
      expect(schema.parse({ method: 'createTab' })).to.deep.equal({
        method: 'createTab',
        params: {},
      });
    });

    it('rejects unsupported URLs in background tabs', () => {
      for (const url of [
        'file:///etc/passwd',
        'chrome://settings',
        'javascript:alert(1)',
        'about:blank#fragment',
        ' about:blank ',
      ]) {
        expect(
          schema.safeParse({
            method: 'createTab',
            params: { url, activate: false },
          }).success,
          `should reject ${JSON.stringify(url)}`,
        ).to.equal(false);
      }
    });

    it('trims navigation URLs without changing credentials, ports, or paths', () => {
      const url = '  https://user:pw@example.com:8443/a/b?c=1#d  ';
      expect(schema.parse({ method: 'goto', params: { url } })).to.deep.equal({
        method: 'goto',
        params: { url: 'https://user:pw@example.com:8443/a/b?c=1#d' },
      });
    });

    it('returns a validation failure rather than throwing for an unparseable URL', () => {
      expect(
        schema.safeParse({ method: 'goto', params: { url: 'ht!tp://[' } })
          .success,
      ).to.equal(false);
    });

    it('leaves private-address policy to the runtime', () => {
      // This schema validates URL schemes, not destination addresses.
      const url = 'http://169.254.169.254/';
      expect(schema.parse({ method: 'goto', params: { url } })).to.deep.equal({
        method: 'goto',
        params: { url },
      });
    });
  });
}

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

  it('accepts explicit plan capability requirements', () => {
    const parsed = AgentParamsSchema.parse({
      method: 'snapshot',
      requiredCapabilities: ['vision', 'os-spoofing'],
    });

    expect(parsed.requiredCapabilities).to.deep.equal([
      'vision',
      'os-spoofing',
    ]);
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

describe('clearSecrets command', () => {
  it('accepts clearSecrets with params omitted or empty', () => {
    for (const command of [
      { method: 'clearSecrets' },
      { method: 'clearSecrets', params: {} },
    ]) {
      expect(
        AgentParamsSchema.safeParse({ commands: [command] }).success,
        `batch: ${JSON.stringify(command)}`,
      ).to.equal(true);
      expect(
        AgentParamsSchema.safeParse(command).success,
        `single: ${JSON.stringify(command)}`,
      ).to.equal(true);
    }
  });

  it('rejects unexpected clearSecrets params through the typed command arm', () => {
    const result = AgentParamsSchema.safeParse({
      commands: [
        { method: 'clearSecrets', params: { unexpected: 'not-allowed' } },
      ],
    });
    expect(result.success).to.equal(false);
  });

  it('rejects unexpected clearSecrets params in single-command form', () => {
    for (const schema of [AgentParamsSchema, AgentToolParamsSchema]) {
      for (const commands of [undefined, []]) {
        const result = schema.safeParse({
          method: 'clearSecrets',
          params: { unexpected: 'not-allowed' },
          commands,
        });
        expect(result.success).to.equal(false);
      }
    }
  });

  it('describes when clearSecrets is needed in the published command schema', () => {
    const schema = JSON.stringify(AgentCommandSchema.toJSONSchema());
    expect(schema).to.include('clearSecrets');
    expect(schema).to.include('single-page apps');
    expect(schema).to.include('replay remains masked');
  });
});

describe('browserless_agent tool schema (OpenAI hosted-MCP import)', () => {
  // The tool advertises AgentToolParamsSchema, whose `commands` is a flat shape
  // rather than the rich per-command discriminated union. That union renders to
  // a JSON Schema too deep/large for OpenAI's hosted-MCP tool import, which
  // rejects the whole tools/list with 424 and takes down every hosted-agent
  // flow. run() re-validates against AgentParamsSchema, so the full per-command
  // contract is still enforced — these tests pin both halves of that split.
  const strictParamCase = {
    commands: [
      { method: 'clearSecrets', params: { unexpected: 'not-allowed' } },
    ],
  };

  it('advertises a flat commands schema (no inlined per-command union)', () => {
    expect(
      AgentToolParamsSchema.safeParse(strictParamCase).success,
      'tool schema must stay flat so OpenAI can import the tool list',
    ).to.equal(true);
    expect(
      AgentParamsSchema.safeParse(strictParamCase).success,
      'the full contract stays strict (enforced in run())',
    ).to.equal(false);
  });

  it('still enforces top-level invariants (profile vs createProfile)', () => {
    expect(
      AgentToolParamsSchema.safeParse({
        profile: 'github',
        createProfile: { name: 'github' },
      }).success,
    ).to.equal(false);
  });
});

describe('saveSecret command', () => {
  const requiredParams = {
    vault: 'Automation',
    title: 'Example login',
    username: 'user@example.com',
    password: 'synthetic-password',
  };

  it('accepts a saveSecret command with all fields', () => {
    const parsed = AgentParamsSchema.parse({
      commands: [
        {
          method: 'saveSecret',
          params: {
            ...requiredParams,
            website: 'https://example.com',
          },
        },
      ],
    });
    const cmd = parsed.commands?.[0];
    expect(cmd?.method).to.equal('saveSecret');
    expect((cmd?.params as { vault?: string })?.vault).to.equal('Automation');
  });

  it('accepts a saveSecret command without a website', () => {
    const result = AgentParamsSchema.safeParse({
      commands: [{ method: 'saveSecret', params: requiredParams }],
    });
    expect(result.success).to.equal(true);
  });

  it('rejects missing required fields without falling back to the generic schema', () => {
    for (const field of ['vault', 'title', 'username', 'password'] as const) {
      const params: Partial<typeof requiredParams> = { ...requiredParams };
      delete params[field];
      const result = AgentParamsSchema.safeParse({
        commands: [{ method: 'saveSecret', params }],
      });
      expect(result.success, `missing ${field}`).to.equal(false);
    }
  });

  it('rejects empty required fields', () => {
    for (const field of ['vault', 'title', 'username', 'password'] as const) {
      const result = AgentParamsSchema.safeParse({
        commands: [
          {
            method: 'saveSecret',
            params: { ...requiredParams, [field]: '' },
          },
        ],
      });
      expect(result.success, `empty ${field}`).to.equal(false);
    }
  });

  it('rejects a non-string website', () => {
    const result = AgentParamsSchema.safeParse({
      commands: [
        {
          method: 'saveSecret',
          params: { ...requiredParams, website: 42 },
        },
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
