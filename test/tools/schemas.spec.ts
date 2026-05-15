import { expect } from 'chai';
import {
  AgentParamsSchema,
  ProxyOptionsSchema,
  PROXY_FIELDS,
} from '../../src/tools/schemas.js';

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
      expect(parsed.externalProxyServer).to.equal(
        'http://user:pass@host:8080',
      );
    });

    it('accepts https:// upstreams', () => {
      const parsed = ProxyOptionsSchema.parse({
        externalProxyServer: 'https://proxy.example.com',
      });
      expect(parsed.externalProxyServer).to.equal(
        'https://proxy.example.com',
      );
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
      expect(() =>
        ProxyOptionsSchema.parse({ proxyCountry: 'us' }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyState: 'new_york' }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxyCity: 'denver' }),
      ).to.throw();
      expect(() =>
        ProxyOptionsSchema.parse({ proxySticky: true }),
      ).to.throw();
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
