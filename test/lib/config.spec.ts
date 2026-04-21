import { expect } from 'chai';
import { getConfig } from '../../src/config.js';

const ENV_KEY = 'OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS';
const BASELINE_LEN = 4; // localhost, 127.0.0.1, claude.ai, chatgpt.com

describe('config.oauthAllowedRedirectUriPatterns', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('returns the baseline defaults when the env var is unset', () => {
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.lengthOf(BASELINE_LEN);
    expect(patterns).to.include('http://localhost:*');
    expect(patterns).to.include('https://claude.ai/api/mcp/auth_callback');
    expect(patterns).to.include(
      'https://chatgpt.com/connector_platform_oauth_redirect',
    );
  });

  it('appends additional patterns to the baseline (does not replace)', () => {
    process.env[ENV_KEY] = 'https://new-host.example.com/*';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.lengthOf(BASELINE_LEN + 1);
    expect(patterns).to.include('http://localhost:*');
    expect(patterns).to.include('https://new-host.example.com/*');
  });

  it('splits comma-separated values and trims whitespace', () => {
    process.env[ENV_KEY] = ' https://a.example/*, https://b.example/* ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.include('https://a.example/*');
    expect(patterns).to.include('https://b.example/*');
  });

  it('drops empty segments from whitespace/comma-only input', () => {
    process.env[ENV_KEY] = '  ,  ,   ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.lengthOf(BASELINE_LEN);
  });

  it('treats an empty env var the same as unset', () => {
    process.env[ENV_KEY] = '';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.lengthOf(BASELINE_LEN);
  });
});
