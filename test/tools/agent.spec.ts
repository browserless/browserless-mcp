import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import {
  buildCrossOriginNotice,
  formatConnectError,
  formatErrorMessage,
  formatScreenshotContent,
  formatSnapshot,
  registerAgentTools,
  sanitizeUpgradeBody,
} from '../../src/tools/agent.js';
import {
  ProfileNotFoundError,
  UpgradeError,
} from '../../src/lib/agent-client.js';
import type { SnapshotResult } from '../../src/lib/agent-client.js';
import type { McpConfig } from '../../src/config.js';
import { makeRejectingServer } from '../helpers/upgrade-server.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
};

describe('browserless_skill tool', () => {
  let server: FastMCP;
  let addToolSpy: sinon.SinonSpy;

  beforeEach(() => {
    server = new FastMCP({ name: 'test', version: '0.1.0' });
    addToolSpy = sinon.spy(server, 'addTool');
    registerAgentTools(server, mockConfig);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('registers both browserless_skill and browserless_agent', () => {
    const names = addToolSpy.getCalls().map((c) => c.args[0].name);
    expect(names).to.include('browserless_skill');
    expect(names).to.include('browserless_agent');
  });

  it('returns the rendered skill body for a known id', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    expect(skillCall, 'browserless_skill not registered').to.exist;

    const result = await skillCall!.args[0].execute(
      { id: 'shadow-dom' },
      mockContext,
    );
    const text = (result.content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.match(/^--- SKILL: shadow-dom/);
    expect(text).to.match(/--- END SKILL ---$/);
    expect(text).to.include('deep selector');
  });

  it('rejects unknown skill ids at the schema level', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    const schema = skillCall!.args[0].parameters as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ id: 'shadow-dom' }).success).to.equal(true);
    expect(schema.safeParse({ id: 'not-a-skill' }).success).to.equal(false);
  });
});

describe('formatScreenshotContent', () => {
  const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

  it('returns image + caption blocks for a valid base64 result', () => {
    const content = formatScreenshotContent(
      { base64: FAKE_PNG },
      { params: {} },
      '',
      '',
    );
    expect(content).to.not.be.null;
    expect(content).to.have.lengthOf(2);
    const caption = content![0] as Extract<Content, { type: 'text' }>;
    const image = content![1] as Extract<Content, { type: 'image' }>;
    expect(caption.text).to.match(/Screenshot captured \(image\/png/);
    expect(image.data).to.equal(FAKE_PNG);
    expect(image.mimeType).to.equal('image/png');
  });

  it('caption reports decoded byte size, not base64 char count', () => {
    // ~660,000 base64 chars decodes to ~495 KB
    const big = 'A'.repeat(660_000);
    const content = formatScreenshotContent(
      { base64: big },
      { params: {} },
      '',
      '',
    );
    const caption = content![0] as Extract<Content, { type: 'text' }>;
    expect(caption.text).to.match(/~\d+ KB/);
    expect(caption.text).to.not.include('base64 chars');
  });

  it('formats large screenshots in MB', () => {
    // ~3 MB worth of base64
    const big = 'A'.repeat(4_200_000);
    const content = formatScreenshotContent(
      { base64: big },
      { params: {} },
      '',
      '',
    );
    const caption = content![0] as Extract<Content, { type: 'text' }>;
    expect(caption.text).to.match(/~\d+(\.\d)? MB/);
  });

  it('uses image/jpeg when type=jpeg was requested', () => {
    const content = formatScreenshotContent(
      { base64: FAKE_PNG },
      { params: { type: 'jpeg' } },
      '',
      '',
    );
    const image = content![1] as Extract<Content, { type: 'image' }>;
    expect(image.mimeType).to.equal('image/jpeg');
  });

  it('uses image/webp when type=webp was requested', () => {
    const content = formatScreenshotContent(
      { base64: FAKE_PNG },
      { params: { type: 'webp' } },
      '',
      '',
    );
    const image = content![1] as Extract<Content, { type: 'image' }>;
    expect(image.mimeType).to.equal('image/webp');
  });

  it('returns null when base64 is missing', () => {
    expect(formatScreenshotContent({}, { params: {} }, '', '')).to.be.null;
    expect(formatScreenshotContent(null, { params: {} }, '', '')).to.be.null;
    expect(formatScreenshotContent({ base64: '' }, { params: {} }, '', '')).to
      .be.null;
  });

  it('appends rendered skills as a third text block when triggered', () => {
    const skills =
      '--- SKILL: modals (src/skills/modals.md) ---\nbody\n--- END SKILL ---';
    const content = formatScreenshotContent(
      { base64: FAKE_PNG },
      { params: {} },
      '',
      skills,
    );
    expect(content).to.have.lengthOf(3);
    const tail = content![2] as Extract<Content, { type: 'text' }>;
    expect(tail.text).to.include('SKILL: modals');
  });

  it('includes batch prefix in the caption when provided', () => {
    const content = formatScreenshotContent(
      { base64: FAKE_PNG },
      { params: {} },
      'Executed: goto → screenshot\n\n',
      '',
    );
    const caption = content![0] as Extract<Content, { type: 'text' }>;
    expect(caption.text).to.match(/^Executed: goto → screenshot/);
    expect(caption.text).to.include('Screenshot captured');
  });
});

describe('formatSnapshot', () => {
  const baseSnap = (
    overrides: Partial<SnapshotResult> = {},
  ): SnapshotResult => ({
    url: 'https://example.com',
    title: 'Example',
    elements: [],
    time: 0,
    ...overrides,
  });

  it('prepends a "! Detected challenge: <type>" header for each entry', () => {
    const out = formatSnapshot(
      baseSnap({ detectedChallenges: ['cloudflare', 'hcaptcha'] }),
    );
    expect(out).to.include('! Detected challenge: cloudflare');
    expect(out).to.include('! Detected challenge: hcaptcha');
  });

  it('omits the header when detectedChallenges is empty or absent', () => {
    expect(formatSnapshot(baseSnap())).to.not.include('Detected challenge');
    expect(formatSnapshot(baseSnap({ detectedChallenges: [] }))).to.not.include(
      'Detected challenge',
    );
  });
});

describe('formatErrorMessage', () => {
  it('emits Category, [CODE]-prefixed head, Suggestion, and Recovery in order', () => {
    const out = formatErrorMessage({
      category: 'SELECTOR_MISS',
      code: 'SELECTOR_NOT_FOUND',
      prefix: 'click failed: ',
      message: 'no element matched "button#submit"',
      suggestion: 'Retry with deep selector "< button#submit"',
      recovery: 'Re-snapshot — the element is not in the current DOM.',
    });

    const lines = out.split('\n\n');
    expect(lines[0]).to.equal('Category: SELECTOR_MISS');
    expect(lines[1]).to.equal(
      '[SELECTOR_NOT_FOUND] click failed: no element matched "button#submit"',
    );
    expect(lines[2]).to.match(/^Suggestion: /);
    expect(lines[3]).to.match(/^Recovery: /);
  });

  it('omits Suggestion when none provided and places Recovery directly after head', () => {
    const out = formatErrorMessage({
      category: 'FORBIDDEN',
      prefix: 'goto failed: ',
      message: 'origin returned 403',
      recovery: 'Cookies/auth may be missing.',
    });
    const lines = out.split('\n\n');
    expect(lines[0]).to.equal('Category: FORBIDDEN');
    expect(lines[1]).to.equal('goto failed: origin returned 403');
    expect(lines[2]).to.equal('Recovery: Cookies/auth may be missing.');
    expect(out).to.not.include('Suggestion:');
  });

  it('appends "Updated snapshot" block when snapshotText is provided', () => {
    const out = formatErrorMessage({
      category: 'UNKNOWN',
      prefix: 'click failed: ',
      message: 'oops',
      recovery: 'Re-snapshot.',
      snapshotText: '--- PAGE SNAPSHOT ---\nfoo\n--- END SNAPSHOT ---',
    });
    expect(out).to.include('Updated snapshot:\n--- PAGE SNAPSHOT ---');
    // Recovery still appears before the snapshot dump
    const recoveryIdx = out.indexOf('Recovery:');
    const snapIdx = out.indexOf('Updated snapshot:');
    expect(recoveryIdx).to.be.greaterThan(0);
    expect(snapIdx).to.be.greaterThan(recoveryIdx);
  });

  it('produces the WS-send-catch shape when no code is given', () => {
    // Mirrors the catch site: message comes from the WebSocket layer,
    // there's no upstream code, no snapshot, no suggestion.
    const out = formatErrorMessage({
      category: 'SESSION_LOST',
      prefix: 'click failed: ',
      message: 'WebSocket closed while waiting for "click" response',
      recovery: 'A fresh session was opened automatically.',
    });
    expect(out).to.match(/^Category: SESSION_LOST\n\n/);
    expect(out).to.include(
      'click failed: WebSocket closed while waiting for "click" response',
    );
    expect(out).to.not.include('[');
    expect(out).to.include('Recovery: A fresh session was opened');
  });
});

describe('buildCrossOriginNotice', () => {
  it('returns a notice when hosts differ', () => {
    const out = buildCrossOriginNotice(
      'https://app.example.com/dashboard',
      'https://accounts.google.com/signin',
    );
    expect(out).to.match(/^! NOTICE: URL changed cross-origin/);
    expect(out).to.include('app.example.com');
    expect(out).to.include('accounts.google.com');
    expect(out).to.include('Prior plan/refs likely invalid');
  });

  it('returns empty string when hosts match (same-origin nav)', () => {
    expect(
      buildCrossOriginNotice('https://example.com/a', 'https://example.com/b'),
    ).to.equal('');
  });

  it('returns a notice when only the protocol differs (http vs https)', () => {
    const out = buildCrossOriginNotice(
      'http://example.com/',
      'https://example.com/',
    );
    expect(out).to.match(/^! NOTICE: URL changed cross-origin/);
  });

  it('returns a notice when only the port differs', () => {
    const out = buildCrossOriginNotice(
      'https://example.com/',
      'https://example.com:8080/',
    );
    expect(out).to.match(/^! NOTICE: URL changed cross-origin/);
  });

  it('returns empty string when previous URL is missing', () => {
    expect(buildCrossOriginNotice(undefined, 'https://example.com')).to.equal(
      '',
    );
  });

  it('returns empty string when either URL is unparseable', () => {
    expect(buildCrossOriginNotice('not-a-url', 'https://example.com')).to.equal(
      '',
    );
    expect(
      buildCrossOriginNotice('https://example.com', 'also-not-a-url'),
    ).to.equal('');
  });
});

describe('formatConnectError', () => {
  it('uses profile-aware wording for ProfileNotFoundError', () => {
    const out = formatConnectError(
      new ProfileNotFoundError('my-login', 'Not Found', ''),
    );
    expect(out).to.include('Profile "my-login" was not found');
    expect(out).to.include('Browserless.saveProfile');
    expect(out).to.include('omit the profile');
  });

  it('renders 400 with the server body', () => {
    const out = formatConnectError(
      new UpgradeError(
        400,
        'Bad Request',
        "Your plan doesn't support city-level proxying.",
      ),
    );
    expect(out).to.match(/^Bad request \(400\)/);
    expect(out).to.include('city-level');
  });

  it('renders 401 with a transport-agnostic auth-fixup hint', () => {
    const out = formatConnectError(
      new UpgradeError(401, 'Unauthorized', 'Bad or missing authentication'),
    );
    expect(out).to.match(/^Authentication failed \(401\)/);
    expect(out).to.include('BROWSERLESS_TOKEN');
    expect(out).to.include('Authorization header');
  });

  it('renders 403 as a plan-gate message', () => {
    const out = formatConnectError(
      new UpgradeError(403, 'Forbidden', 'Plan does not allow residential'),
    );
    expect(out).to.match(/^Forbidden \(403\)/);
    expect(out).to.include('plan');
  });

  it('renders 429 with a concurrency / wait hint', () => {
    const out = formatConnectError(
      new UpgradeError(
        429,
        'Too Many Requests',
        'Your plan allows 1 concurrent session',
      ),
    );
    expect(out).to.match(/^Concurrency limit reached \(429\)/);
    expect(out).to.include('Wait for');
  });

  it('falls back to a generic upgrade message for unrecognized statuses', () => {
    const out = formatConnectError(
      new UpgradeError(502, 'Bad Gateway', 'upstream timeout'),
    );
    expect(out).to.include('HTTP 502');
    expect(out).to.include('upstream timeout');
  });

  it('falls back to the raw message for non-UpgradeError errors', () => {
    const out = formatConnectError(new Error('ECONNREFUSED'));
    expect(out).to.equal('Failed to connect to browser agent: ECONNREFUSED');
  });
});

describe('sanitizeUpgradeBody', () => {
  it('returns empty string for an empty body', () => {
    expect(sanitizeUpgradeBody('')).to.equal('');
    expect(sanitizeUpgradeBody('   ')).to.equal('');
  });

  it('passes a short plain-text body through unchanged', () => {
    expect(sanitizeUpgradeBody('Profile "x" was not found')).to.equal(
      'Profile "x" was not found',
    );
  });

  it('strips tags from an nginx HTML error page', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
      '<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n' +
      '<hr><center>nginx</center>\r\n</body>\r\n</html>';
    const out = sanitizeUpgradeBody(html);
    expect(out).to.not.include('<');
    expect(out).to.not.include('>');
    expect(out).to.include('502 Bad Gateway');
    expect(out).to.include('nginx');
  });

  it('truncates an oversized plain-text body with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = sanitizeUpgradeBody(long);
    expect(out.length).to.be.lessThanOrEqual(201);
    expect(out.endsWith('…')).to.equal(true);
  });

  it('does not strip tags from a non-HTML body that happens to contain <', () => {
    // Plain-text bodies that have `<` or `>` (e.g. URLs in brackets) should
    // not be tag-stripped. The probe is anchored to known HTML element tags.
    const text = 'Use <https://example.com> for details';
    expect(sanitizeUpgradeBody(text)).to.equal(text);
  });
});

describe('formatConnectError with proxy-injected errors', () => {
  it('renders empty-body 401 without a "server says" clause', () => {
    const out = formatConnectError(new UpgradeError(401, 'Unauthorized', ''));
    expect(out).to.include('Authentication failed (401)');
    expect(out).to.not.include('server says');
  });

  it('renders empty-body 429 without a body clause', () => {
    const out = formatConnectError(
      new UpgradeError(429, 'Too Many Requests', ''),
    );
    expect(out).to.match(/^Concurrency limit reached \(429\)\. Wait for/);
  });

  it('renders nginx HTML 502 body as cleaned text', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n' +
      '<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>';
    const out = formatConnectError(new UpgradeError(502, 'Bad Gateway', html));
    expect(out).to.include('HTTP 502');
    expect(out).to.not.include('<html>');
    expect(out).to.include('502 Bad Gateway');
  });

  it('renders the legacy-endpoint 403 with the redirect message', () => {
    const out = formatConnectError(
      new UpgradeError(
        403,
        'Forbidden',
        'This URL is a legacy endpoint, please use https://production-sfo.browserless.io...',
      ),
    );
    expect(out).to.match(/^Forbidden \(403\)/);
    expect(out).to.include('legacy endpoint');
    expect(out).to.include('production-sfo');
  });
});

const getAgentExecute = (
  apiUrl: string,
): ((args: unknown, ctx: unknown) => unknown) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  registerAgentTools(server, { ...mockConfig, browserlessApiUrl: apiUrl });
  const agentCall = addToolSpy
    .getCalls()
    .find((c) => c.args[0].name === 'browserless_agent');
  return agentCall!.args[0].execute as (args: unknown, ctx: unknown) => unknown;
};

describe('browserless_agent retry-guard (runCommands)', () => {
  // Each test uses a distinct mcpSessionId so the module-level session
  // cache can't return a stale entry from a prior case.
  const ctx = (sessionId: string) => ({ ...mockContext, sessionId });

  afterEach(() => sinon.restore());

  it('does NOT retry a non-retryable upgrade failure (401)', async () => {
    const srv = await makeRejectingServer(
      401,
      'Bad or missing authentication.',
    );
    try {
      const execute = getAgentExecute(srv.url);
      try {
        await execute(
          { method: 'goto', params: { url: 'https://example.com' } },
          ctx('retry-guard-401'),
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.include(
          'Authentication failed (401)',
        );
      }
      expect(srv.hits()).to.equal(1);
    } finally {
      await srv.close();
    }
  });

  it('does NOT retry a 404 with a profile (ProfileNotFoundError)', async () => {
    const srv = await makeRejectingServer(404, 'Profile "ghost" was not found');
    try {
      const execute = getAgentExecute(srv.url);
      try {
        await execute(
          {
            method: 'goto',
            params: { url: 'https://example.com' },
            profile: 'ghost',
          },
          ctx('retry-guard-404'),
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.include('Profile "ghost"');
      }
      expect(srv.hits()).to.equal(1);
    } finally {
      await srv.close();
    }
  });

  it('DOES retry once on a retryable upgrade failure (503)', async () => {
    const srv = await makeRejectingServer(503, 'Service Unavailable');
    try {
      const execute = getAgentExecute(srv.url);
      try {
        await execute(
          { method: 'goto', params: { url: 'https://example.com' } },
          ctx('retry-guard-503'),
        );
        expect.fail('expected UserError');
      } catch (err) {
        // Second attempt also failed; surface the typed error.
        expect((err as Error).message).to.include('HTTP 503');
      }
      expect(srv.hits()).to.equal(2);
    } finally {
      await srv.close();
    }
  });
});
