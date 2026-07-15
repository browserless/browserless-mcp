import { expect } from 'chai';
import { getConfig, classifyComplianceInput } from '../../src/config.js';

const ENV_KEY = 'OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS';
const BASELINE_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector/oauth/*',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://api.devin.ai/mcp/oauth/callback',
  'https://api.beta.devin.ai/mcp/oauth/callback',
  'https://api.itsdev.in/mcp/oauth/callback',
  'https://www.make.com/oauth/cb/mcp',
  'https://us1.make.celonis.com/oauth/cb/mcp',
  'https://eu1.make.celonis.com/oauth/cb/mcp',
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

describe('config.complianceMode', () => {
  const COMPLIANCE_KEY = 'MCP_COMPLIANCE_MODE';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[COMPLIANCE_KEY];
    delete process.env[COMPLIANCE_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[COMPLIANCE_KEY];
    else process.env[COMPLIANCE_KEY] = original;
  });

  it('defaults to false (full surface) when the env var is unset', () => {
    expect(getConfig().complianceMode).to.equal(false);
  });

  it('is true for "true"', () => {
    process.env[COMPLIANCE_KEY] = 'true';
    expect(getConfig().complianceMode).to.equal(true);
  });

  it('fails closed: any set value that is not an explicit opt-out enables compliant mode', () => {
    // '' (set-but-empty) is included: a set var, even empty, must not fall
    // through to the full surface.
    for (const v of ['1', 'yes', 'TRUE', 'on', ' true ', 'garbage', '']) {
      process.env[COMPLIANCE_KEY] = v;
      expect(getConfig().complianceMode, `value ${JSON.stringify(v)}`).to.equal(
        true,
      );
    }
  });

  it('serves the full surface only for unset or an explicit opt-out token', () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE', ' off ']) {
      process.env[COMPLIANCE_KEY] = v;
      expect(getConfig().complianceMode, `value ${JSON.stringify(v)}`).to.equal(
        false,
      );
    }
  });

  it('classifyComplianceInput distinguishes unset / opt-out / opt-in / unrecognized', () => {
    expect(classifyComplianceInput(undefined)).to.equal('unset');
    for (const v of ['false', '0', 'no', 'off', 'FALSE', ' off '])
      expect(classifyComplianceInput(v), v).to.equal('opt-out');
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' true '])
      expect(classifyComplianceInput(v), v).to.equal('opt-in');
    // Fumbled values still parse to compliant (fail-closed) but classify as
    // unrecognized so the boot log warns instead of reading them as opt-in.
    for (const v of ['ture', 'compliant', 'garbage', ''])
      expect(classifyComplianceInput(v), v).to.equal('unrecognized');
  });
});
