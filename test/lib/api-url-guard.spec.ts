import { expect } from 'chai';
import {
  allowedApiUrlHosts,
  assertAllowedApiUrl,
  InvalidApiUrlError,
} from '../../src/lib/api-url-guard.js';

const config = {
  browserlessApiUrl: 'https://production-sfo.browserless.io',
  allowedApiUrlHosts: [] as string[],
};

describe('API URL guard', () => {
  it('accepts Browserless regional, root, and path-bearing HTTPS URLs', () => {
    for (const candidate of [
      'https://production-lon.browserless.io',
      'https://production-ams.browserless.io',
      'https://production-sfo.browserless.io/e/TOK',
      'https://browserless.io',
      config.browserlessApiUrl,
    ]) {
      expect(() => assertAllowedApiUrl(candidate, config)).not.to.throw();
    }
  });

  it('rejects plain-HTTP Browserless URLs, which would send the token unencrypted', () => {
    for (const candidate of [
      'http://production-sfo.browserless.io',
      'http://production-lon.browserless.io/',
      'http://chrome.browserless.io',
      'http://browserless.io',
      'HTTP://PRODUCTION-SFO.BROWSERLESS.IO',
    ]) {
      expect(() => assertAllowedApiUrl(candidate, config), candidate).to.throw(
        InvalidApiUrlError,
        'Browserless API URL overrides must use https://',
      );
    }
  });

  it('still accepts a plain-HTTP Browserless host when it is the configured origin', () => {
    const custom = {
      ...config,
      browserlessApiUrl: 'http://staging.browserless.io',
    };
    expect(() =>
      assertAllowedApiUrl('http://staging.browserless.io/', custom),
    ).not.to.throw();
    expect(() =>
      assertAllowedApiUrl('http://production-sfo.browserless.io', custom),
    ).to.throw(InvalidApiUrlError);
  });

  it('rejects unsafe and malformed URLs', () => {
    for (const candidate of [
      'http://169.254.169.254/metadata/v1.json#',
      'http://127.0.0.1:9999',
      'http://10.0.0.5',
      'https://evilbrowserless.io',
      'https://browserless.io.evil.com',
      'https://eu.example.com',
      'file:///etc/passwd',
      'ftp://browserless.io',
      'https://user:pw@production-sfo.browserless.io',
      'https://production-sfo.browserless.io?x=1',
      'https://production-sfo.browserless.io#frag',
      'not-a-url',
      '',
      '//evil.com',
      'https://[::1]:80',
      `https://${'a'.repeat(300)}.com`,
      'https://production-sfo.browserless.io/path\0suffix',
      `https://production-sfo.browserless.io/${'x'.repeat(8192)}`,
    ]) {
      expect(() => assertAllowedApiUrl(candidate, config), candidate).to.throw(
        InvalidApiUrlError,
      );
    }
  });

  for (const candidate of [
    'https://production-sfo.browserless.io#',
    'https://production-sfo.browserless.io?',
    'https://.browserless.io',
  ]) {
    it(`rejects ${candidate}`, () => {
      expect(() => assertAllowedApiUrl(candidate, config)).to.throw(
        InvalidApiUrlError,
      );
    });
  }

  for (const candidate of [
    'http://browserless-cloud:9999',
    'https://browserless-cloud:3000',
  ]) {
    it(`rejects an alternate configured origin: ${candidate}`, () => {
      expect(() =>
        assertAllowedApiUrl(candidate, {
          ...config,
          browserlessApiUrl: 'http://browserless-cloud:3000',
        }),
      ).to.throw(InvalidApiUrlError);
    });
  }

  it('accepts only the configured origin for custom deployments', () => {
    for (const browserlessApiUrl of [
      'http://browserless-cloud:3000',
      'https://your-browserless-instance.example.com',
    ]) {
      const custom = { ...config, browserlessApiUrl };
      expect(() =>
        assertAllowedApiUrl(browserlessApiUrl, custom),
      ).not.to.throw();
      expect(() =>
        assertAllowedApiUrl('https://other.example.com', custom),
      ).to.throw(InvalidApiUrlError);
    }
  });

  it('accepts explicitly configured additional hosts', () => {
    const custom = {
      ...config,
      allowedApiUrlHosts: ['extra.example.com', 'other.example.net'],
    };
    expect(allowedApiUrlHosts(custom)).to.include.members([
      'extra.example.com',
      'other.example.net',
    ]);
    expect(() =>
      assertAllowedApiUrl('https://extra.example.com', custom),
    ).not.to.throw();
    expect(() =>
      assertAllowedApiUrl('http://extra.example.com', custom),
    ).not.to.throw();
    expect(() =>
      assertAllowedApiUrl('https://unlisted.example.com', custom),
    ).to.throw(InvalidApiUrlError);
  });

  it('has no additional hosts by default', () => {
    expect(allowedApiUrlHosts(config)).to.deep.equal([]);
  });

  it('does not disguise invalid operator configuration as a client error', () => {
    expect(() =>
      assertAllowedApiUrl('http://custom.example', {
        ...config,
        browserlessApiUrl: 'not-a-url',
      }),
    )
      .to.throw(TypeError)
      .and.not.to.be.instanceOf(InvalidApiUrlError);
  });

  it('accepts equivalent origins and path-bearing configured URLs', () => {
    expect(() =>
      assertAllowedApiUrl('http://custom.example:80/subpath', {
        browserlessApiUrl: 'http://custom.example/base',
      }),
    ).not.to.throw();
  });
});
