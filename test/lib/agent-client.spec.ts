import { expect } from 'chai';
import {
  buildAgentWsUrl,
  proxyFingerprint,
} from '../../src/lib/agent-client.js';
import type { ProxyOptions } from '../../src/tools/schemas.js';

describe('agent-client buildAgentWsUrl', () => {
  it('uses ws:// for http and only sets token when no proxy options are passed', () => {
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok'));
    expect(url.protocol).to.equal('ws:');
    expect(url.host).to.equal('localhost:3000');
    expect(url.pathname).to.equal('/chromium/agent');
    expect([...url.searchParams.keys()]).to.deep.equal(['token']);
    expect(url.searchParams.get('token')).to.equal('tok');
  });

  it('uses wss:// for https', () => {
    const url = new URL(buildAgentWsUrl('https://mcp.browserless.io', 'tok'));
    expect(url.protocol).to.equal('wss:');
  });

  it('URL-encodes the token', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'a/b c?d&e=1'),
    );
    expect(url.searchParams.get('token')).to.equal('a/b c?d&e=1');
  });

  it('sets proxy=residential when requested', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', { proxy: 'residential' }),
    );
    expect(url.searchParams.get('proxy')).to.equal('residential');
  });

  it('passes country, sticky, and locale-match flags', () => {
    const proxy: ProxyOptions = {
      proxy: 'residential',
      proxyCountry: 'us',
      proxySticky: true,
      proxyLocaleMatch: true,
    };
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok', proxy));
    expect(url.searchParams.get('proxy')).to.equal('residential');
    expect(url.searchParams.get('proxyCountry')).to.equal('us');
    expect(url.searchParams.get('proxySticky')).to.equal('true');
    expect(url.searchParams.get('proxyLocaleMatch')).to.equal('true');
  });

  it('omits sticky when false (server uses presence-only semantics)', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxySticky: false,
      }),
    );
    expect(url.searchParams.has('proxySticky')).to.equal(false);
  });

  it('round-trips externalProxyServer with credentials', () => {
    const ext = 'http://user:pass@host.example.com:8080';
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        externalProxyServer: ext,
      }),
    );
    expect(url.searchParams.get('externalProxyServer')).to.equal(ext);
  });

  it('passes proxyState and proxyCity when set', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxyState: 'CA',
        proxyCity: 'Los Angeles',
      }),
    );
    expect(url.searchParams.get('proxyState')).to.equal('CA');
    expect(url.searchParams.get('proxyCity')).to.equal('Los Angeles');
  });
});

describe('agent-client proxyFingerprint', () => {
  it('returns empty string for undefined', () => {
    expect(proxyFingerprint(undefined)).to.equal('');
  });

  it('returns empty string for an empty object', () => {
    expect(proxyFingerprint({})).to.equal('');
  });

  it('produces a stable string from the same inputs regardless of key order', () => {
    const a: ProxyOptions = { proxy: 'residential', proxyCountry: 'us' };
    const b: ProxyOptions = { proxyCountry: 'us', proxy: 'residential' };
    expect(proxyFingerprint(a)).to.equal(proxyFingerprint(b));
  });

  it('differs when any field differs', () => {
    const us = proxyFingerprint({ proxy: 'residential', proxyCountry: 'us' });
    const de = proxyFingerprint({ proxy: 'residential', proxyCountry: 'de' });
    expect(us).to.not.equal(de);
  });

  it('differs from no-proxy when only sticky is set', () => {
    expect(proxyFingerprint({ proxySticky: true })).to.not.equal('');
  });

  it('does not include externalProxyServer credentials verbatim', () => {
    const fp = proxyFingerprint({
      externalProxyServer: 'http://user:hunter2@host.example.com:8080',
    });
    expect(fp).to.not.include('hunter2');
    expect(fp).to.not.include('user:');
    expect(fp).to.not.include('host.example.com');
  });

  it('keys distinct externalProxyServer URLs to distinct fingerprints', () => {
    const a = proxyFingerprint({
      externalProxyServer: 'http://u:p@host-a:8080',
    });
    const b = proxyFingerprint({
      externalProxyServer: 'http://u:p@host-b:8080',
    });
    expect(a).to.not.equal(b);
    expect(a).to.not.equal('');
  });
});
