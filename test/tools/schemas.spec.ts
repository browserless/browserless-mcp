import { expect } from 'chai';
import { AgentParamsSchema } from '../../src/tools/agent.js';
import { FunctionParamsSchema } from '../../src/tools/function.js';
import {
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
    it('accepts an empty object', () => {
      expect(() => ProxyOptionsSchema.parse({})).to.not.throw();
    });

    it('accepts proxy alone', () => {
      expect(() =>
        ProxyOptionsSchema.parse({ proxy: 'residential' }),
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
        { method: 'loadSecret', params: { ref: 'op://Automation/imdb/username' } },
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
