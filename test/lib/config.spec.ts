import { expect } from 'chai';
import { getConfig } from '../../src/config.js';

const ENV_KEY = 'OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS';
const BASELINE_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://api.devin.ai/mcp/oauth/callback',
  'https://api.beta.devin.ai/mcp/oauth/callback',
  'https://api.itsdev.in/mcp/oauth/callback',
];

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

  it('returns exactly the baseline defaults when the env var is unset', () => {
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });

  it('appends additional patterns to the baseline (does not replace)', () => {
    process.env[ENV_KEY] = 'https://new-host.example.com/*';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.include.members(BASELINE_PATTERNS);
    expect(patterns).to.include('https://new-host.example.com/*');
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length + 1);
  });

  it('splits comma-separated values and trims whitespace', () => {
    process.env[ENV_KEY] = ' https://a.example/*, https://b.example/* ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.include.members(BASELINE_PATTERNS);
    expect(patterns).to.include('https://a.example/*');
    expect(patterns).to.include('https://b.example/*');
  });

  it('drops empty segments from whitespace/comma-only input and preserves baseline', () => {
    process.env[ENV_KEY] = '  ,  ,   ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });

  it('treats an empty env var the same as unset', () => {
    process.env[ENV_KEY] = '';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });
});
