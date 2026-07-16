import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import {
  buildCrossOriginNotice,
  formatConnectError,
  formatDownloads,
  formatErrorMessage,
  formatScreenshotContent,
  formatScreenshotToDisk,
  formatSnapshot,
  normalizeUploadCommand,
  buildSkillEventProps,
  registerAgentTools,
  sanitizeUpgradeBody,
} from '../../src/tools/agent.js';
import { fileTransferModeNote } from '../../src/skills/system-prompt.js';
import { mkdtemp, readFile as fsReadFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadUri, storeDownload } from '../../src/lib/download-store.js';
import {
  ProfileNotFoundError,
  UpgradeError,
} from '../../src/lib/agent-client.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import type { SnapshotResult } from '../../src/@types/types.js';
import type { McpConfig } from '../../src/@types/types.js';
import {
  hydrateRemoteSkills,
  __resetRemoteSkillsForTesting,
} from '../../src/skills/sites.js';
import {
  makeRejectingServer,
  makeRespondingServer,
} from '../helpers/upgrade-server.js';

const seedSiteSkill = (host: string, task: string, body: string) =>
  hydrateRemoteSkills(
    `https://${host}`,
    'https://api.example.com',
    'test-token',
    (async () =>
      ({
        ok: true,
        json: async () => [{ task, title: task, skill_md: body }],
      }) as unknown as Response) as typeof fetch,
  );

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
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
    __resetRemoteSkillsForTesting();
    server = new FastMCP({ name: 'test', version: '0.1.0' });
    addToolSpy = sinon.spy(server, 'addTool');
    registerAgentTools(server, mockConfig);
  });

  afterEach(() => {
    sinon.restore();
    __resetRemoteSkillsForTesting();
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

  it('requires either an id or a site at the schema level', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    const schema = skillCall!.args[0].parameters as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ id: 'shadow-dom' }).success).to.equal(true);
    expect(schema.safeParse({ site: 'ebay.com' }).success).to.equal(true);
    expect(schema.safeParse({}).success).to.equal(false);
  });

  it('throws UserError for an unknown in-house id', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    try {
      await skillCall!.args[0].execute({ id: 'not-a-skill' }, mockContext);
      expect.fail('expected UserError');
    } catch (err) {
      expect((err as Error).message).to.include('Unknown skill id');
    }
  });

  it('lists site recipes for a known host without injecting the body', async () => {
    await seedSiteSkill(
      'ebay.com',
      'find-a-product',
      '---\nname: find-a-product\ntitle: Find\nwebsite: ebay.com\n---\n# Find\n## Purpose\nx',
    );
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    const result = await skillCall!.args[0].execute(
      { site: 'ebay.com' },
      mockContext,
    );
    const text = (result.content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.include('SITE RECIPES for ebay.com');
    expect(text).to.include('browserless_skill { id:');
    expect(text).to.not.include('## Purpose');
  });

  it('reports no recipe for an unknown host', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    const result = await skillCall!.args[0].execute(
      { site: 'no-such-host.example' },
      mockContext,
    );
    const text = (result.content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.include('No site recipe found');
  });

  it('tags analytics for site lookups, site loads, and in-house loads', () => {
    expect(buildSkillEventProps({ site: 'ebay.com' }, 'body')).to.include({
      skill_action: 'list_site',
      site_skill: true,
      host: 'ebay.com',
    });
    expect(
      buildSkillEventProps({ id: 'ebay.com/find-a-product' }, 'body'),
    ).to.include({
      skill_action: 'load',
      site_skill: true,
      host: 'ebay.com',
    });
    const inHouse = buildSkillEventProps({ id: 'shadow-dom' }, 'body');
    expect(inHouse).to.include({ skill_action: 'load', site_skill: false });
    expect(inHouse.host).to.equal(undefined);
    expect(buildSkillEventProps({ id: 'x' }, '').success).to.equal(false);
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

describe('formatScreenshotToDisk', () => {
  const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

  it('writes the screenshot to disk and reports a path, no inline image (stdio)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-shot-'));
    const prev = process.env.BROWSERLESS_DOWNLOAD_DIR;
    process.env.BROWSERLESS_DOWNLOAD_DIR = dir;
    try {
      const content = await formatScreenshotToDisk(
        { base64: FAKE_PNG },
        { params: {} },
        '',
        '',
        { transport: 'stdio' },
      );
      expect(content).to.not.be.null;
      // No image content block — bytes live on disk, not in context.
      expect(content!.every((c) => c.type === 'text')).to.be.true;
      const text = (content![0] as Extract<Content, { type: 'text' }>).text;
      expect(text).to.include('saved to disk');
      expect(text).to.include(dir);
      // The reported path holds the decoded bytes, and base64 never leaks.
      expect(JSON.stringify(content)).to.not.include(FAKE_PNG);
      const reported = text.split('- ')[1].split(' (')[0];
      const written = await fsReadFile(reported);
      expect(written.equals(Buffer.from(FAKE_PNG, 'base64'))).to.be.true;
    } finally {
      if (prev === undefined) delete process.env.BROWSERLESS_DOWNLOAD_DIR;
      else process.env.BROWSERLESS_DOWNLOAD_DIR = prev;
    }
  });

  it('gives a single-use GET URL with the .jpg extension over HTTP', async () => {
    const content = await formatScreenshotToDisk(
      { base64: FAKE_PNG },
      { params: { type: 'jpeg' } },
      '',
      '',
      {
        transport: 'httpStream',
        mcpBaseUrl: 'https://mcp.example.com',
        token: 'tok-1',
      },
    );
    const text = (content![0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.match(
      /curl -s "https:\/\/mcp\.example\.com\/download\/[^"]+\?token=tok-1"/,
    );
    expect(text).to.include('screenshot.jpg');
    expect(JSON.stringify(content)).to.not.include(FAKE_PNG);
  });

  it('returns null when base64 is missing (caller falls back to JSON)', async () => {
    expect(
      await formatScreenshotToDisk({}, { params: {} }, '', '', {
        transport: 'stdio',
      }),
    ).to.be.null;
    expect(
      await formatScreenshotToDisk(null, { params: {} }, '', '', {
        transport: 'stdio',
      }),
    ).to.be.null;
  });
});

describe('fileTransferModeNote', () => {
  it('tells the model to use a local path in stdio mode (no base64)', () => {
    const note = fileTransferModeNote('stdio', 'https://mcp.example.com');
    expect(note).to.match(/stdio/i);
    expect(note).to.include('path');
    expect(note).to.match(/do NOT base64/i);
    expect(note).to.not.include('/upload');
  });

  it('tells the model to stage via /upload in HTTP mode', () => {
    const note = fileTransferModeNote('httpStream', 'https://mcp.example.com');
    expect(note).to.match(/HTTP/);
    expect(note).to.include('https://mcp.example.com/upload');
    expect(note).to.match(/never base64/i);
  });
});

describe('normalizeUploadCommand', () => {
  it('reads a local path into base64 content (stdio)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-upload-'));
    const path = join(dir, 'hello.txt');
    await writeFile(path, 'Hello World!');

    const cmd = {
      method: 'uploadFile',
      params: { selector: 'input', files: [{ path }] },
    };
    await normalizeUploadCommand(cmd, 'stdio');

    const file = (cmd.params.files as Record<string, unknown>[])[0];
    expect(file.path).to.be.undefined;
    expect(file.name).to.equal('hello.txt');
    expect(Buffer.from(file.content as string, 'base64').toString()).to.equal(
      'Hello World!',
    );
  });

  it('rejects a local path in httpStream mode with a staging recipe', async () => {
    const cmd = {
      method: 'uploadFile',
      params: { selector: 'input', files: [{ path: '/etc/hosts' }] },
    };
    let threw = false;
    try {
      await normalizeUploadCommand(
        cmd,
        'httpStream',
        'https://mcp.example.com',
      );
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      expect(msg).to.match(/not available in HTTP mode/);
      expect(msg).to.include('curl -s -F file=@"/etc/hosts"');
      expect(msg).to.include(
        'https://mcp.example.com/upload?token=<YOUR_BROWSERLESS_TOKEN>',
      );
    }
    expect(threw, 'expected normalizeUploadCommand to throw').to.be.true;
  });

  it('leaves base64 content and non-upload commands untouched', async () => {
    const cmd = {
      method: 'uploadFile',
      params: { selector: 'input', files: [{ content: 'YWJj', name: 'a' }] },
    };
    await normalizeUploadCommand(cmd, 'httpStream');
    const file = (cmd.params.files as Record<string, unknown>[])[0];
    expect(file.content).to.equal('YWJj');

    const other = { method: 'click', params: { selector: 'a' } };
    await normalizeUploadCommand(other, 'stdio');
    expect(other.params.selector).to.equal('a');
  });

  it('resolves a download handle to base64 content (any transport)', async () => {
    const record = await storeDownload(
      'grabbed.bin',
      'application/octet-stream',
      Buffer.from('Hello World!'),
    );
    const cmd = {
      method: 'uploadFile',
      params: {
        selector: 'input',
        files: [{ handle: downloadUri(record.id) }],
      },
    };
    await normalizeUploadCommand(cmd, 'httpStream');
    const file = (cmd.params.files as Record<string, unknown>[])[0];
    expect(file.handle).to.be.undefined;
    expect(file.name).to.equal('grabbed.bin');
    expect(Buffer.from(file.content as string, 'base64').toString()).to.equal(
      'Hello World!',
    );
  });

  it('throws on an unknown upload handle', async () => {
    const cmd = {
      method: 'uploadFile',
      params: { selector: 'input', files: [{ handle: 'nope://missing' }] },
    };
    let threw = false;
    try {
      await normalizeUploadCommand(cmd, 'stdio');
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/Unknown upload handle/);
    }
    expect(threw).to.be.true;
  });
});

describe('formatDownloads (httpStream)', () => {
  it('surfaces a notification + single-use GET URL, never the base64 bytes', async () => {
    const content = await formatDownloads(
      [{ filename: 'report.csv', mimeType: 'text/csv', size: 3, data: 'YWJj' }],
      '',
      '',
      {
        transport: 'httpStream',
        mcpBaseUrl: 'https://mcp.example.com',
        token: 'tok-1',
      },
    );
    const text = (content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.include('report.csv');
    // GET recipe with the real base URL + token, marked single use.
    expect(text).to.match(
      /curl -s "https:\/\/mcp\.example\.com\/download\/[^"]+\?token=tok-1"/,
    );
    expect(text).to.include('single use');
    // The base64 must never appear in the returned content.
    expect(JSON.stringify(content)).to.not.include('YWJj');
  });

  it('degrades oversized/failed downloads to a text note with the source URL', async () => {
    const content = await formatDownloads(
      [
        {
          filename: 'big.bin',
          error: 'FileTooLarge',
          maxBytes: 1048576,
          sourceUrl: 'https://example.com/big.bin',
        },
      ],
      '',
      '',
      {
        transport: 'httpStream',
        mcpBaseUrl: 'https://mcp.example.com',
        token: 'tok-1',
      },
    );
    const text = (content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.match(/big\.bin: FileTooLarge/);
    expect(text).to.include('fetch directly: https://example.com/big.bin');
    expect(text).to.not.include('/download/');
  });

  it('reports an in-progress download as a progress line, no fetch URL', async () => {
    const content = await formatDownloads(
      [
        {
          filename: 'movie.mov',
          inProgress: true,
          receivedBytes: 2 * 1048576,
          totalBytes: 10 * 1048576,
        },
      ],
      '',
      '',
      {
        transport: 'httpStream',
        mcpBaseUrl: 'https://mcp.example.com',
        token: 'tok-1',
      },
    );
    const text = (content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.match(/movie\.mov — downloading \(2\.0MB \/ 10\.0MB\)/);
    expect(text).to.include('touch the browser again');
    expect(text).to.not.include('/download/');
  });
});

describe('formatDownloads (stdio)', () => {
  it('writes the file to disk and reports a reusable path, no base64', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-dl-'));
    const prev = process.env.BROWSERLESS_DOWNLOAD_DIR;
    process.env.BROWSERLESS_DOWNLOAD_DIR = dir;
    try {
      const content = await formatDownloads(
        [
          {
            filename: 'report.csv',
            mimeType: 'text/csv',
            size: 3,
            data: 'YWJj',
          },
        ],
        '',
        '',
        { transport: 'stdio' },
      );
      const text = (content[0] as Extract<Content, { type: 'text' }>).text;
      expect(text).to.include('report.csv');
      expect(text).to.include(dir);
      expect(text).to.not.include('YWJj');
      // The reported path points at the written bytes.
      const reported = text.split('- ')[1].split(' (')[0];
      const written = await fsReadFile(reported);
      expect(written.toString()).to.equal('abc');
    } finally {
      if (prev === undefined) delete process.env.BROWSERLESS_DOWNLOAD_DIR;
      else process.env.BROWSERLESS_DOWNLOAD_DIR = prev;
    }
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
    expect(out).to.include('Stop retrying');
    expect(out).to.include('wait for');
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
    expect(out).to.match(/^Concurrency limit reached \(429\)\. Stop retrying/);
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

  it('returns the saved-download handle when a screenshot { toDisk } batch ends with close', async () => {
    // 1x1 PNG so getScreenshotPayload sees a real base64 payload.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const srv = await makeRespondingServer((method) =>
      method === 'screenshot' ? { base64: png } : { closed: true },
    );
    try {
      const execute = getAgentExecute(srv.url);
      const result = (await execute(
        {
          commands: [
            { method: 'screenshot', params: { toDisk: true } },
            { method: 'close' },
          ],
        },
        ctx('todisk-then-close'),
      )) as { content: Content[] };
      const text = (result.content[0] as Extract<Content, { type: 'text' }>)
        .text;
      // toDisk branch fired: a reusable path, not the inline image/JSON the
      // close-as-lastCmd bug produced.
      expect(text).to.include('Screenshot saved to disk');
      expect(text).to.include('reuse as uploadFile');
      expect(result.content.some((c) => c.type === 'image')).to.equal(false);
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

describe('browserless_agent _prompt capture', () => {
  afterEach(() => sinon.restore());

  const registerWithAnalytics = (config: McpConfig) => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    registerAgentTools(server, config, analytics);
    const added = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_agent')!.args[0] as any;
    return { added, execute: added.execute, fire };
  };

  it('injects _prompt into the schema and logs it redacted', async () => {
    const { added, execute, fire } = registerWithAnalytics(mockConfig);
    expect((added.parameters as any).shape).to.have.property('_prompt');

    await execute(
      { method: 'close', _prompt: 'log in with password: hunter2secret' },
      { ...mockContext, sessionId: 'prompt-redact' },
    );

    expect(fire.calledOnce).to.be.true;
    const props = fire.firstCall.args[2] as Record<string, unknown>;
    expect(props._prompt).to.be.a('string');
    expect(props._prompt).to.not.include('hunter2secret');
    expect(props._prompt).to.include('[REDACTED]');
  });

  it('redacts a JSON-style credential payload before analytics forwarding', async () => {
    const { execute, fire } = registerWithAnalytics(mockConfig);

    await execute(
      {
        method: 'close',
        _prompt: 'submit {"user":"bob","password":"hunter2secret"}',
      },
      { ...mockContext, sessionId: 'prompt-redact-json' },
    );

    const props = fire.firstCall.args[2] as Record<string, unknown>;
    expect(props._prompt).to.not.include('hunter2secret');
    expect(props._prompt).to.include('[REDACTED]');
    // Non-secret sibling fields survive.
    expect(props._prompt).to.include('bob');
  });

  it('does NOT inject _prompt on the compliant surface', () => {
    const { added } = registerWithAnalytics({
      ...mockConfig,
      complianceMode: true,
    });
    expect((added.parameters as any).shape).to.not.have.property('_prompt');
  });
});
