import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sinon from 'sinon';
import type { McpConfig } from '../../src/@types/types.js';
import { clearResolverCache } from '../../src/lib/account-resolver.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';
import { registerUploadRoute } from '../../src/resources/upload-route.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: '',
  supabaseServiceRoleKey: '',
} as McpConfig;

describe('upload route', () => {
  let upstream: Server;
  let upstreamStatus: number | undefined;
  let upstreamBody: string | undefined;
  let upstreamFailure: 'offline' | 'timeout' | undefined;
  let pressurePath: string;
  let directory: string;
  let previousDirectory: string | undefined;
  let warnings: sinon.SinonStub;

  beforeEach(async () => {
    upstreamStatus = undefined;
    upstreamBody = undefined;
    upstreamFailure = undefined;
    pressurePath = '/backend/pressure';
    warnings = sinon.stub(console, 'warn');
    upstream = createServer((req, res) => {
      if (upstreamFailure === 'offline') {
        req.socket.destroy();
        return;
      }
      if (upstreamFailure === 'timeout') return;
      const url = new URL(req.url!, 'http://localhost');
      const valid = ['owner-a', 'owner-b', 'owner+with&reserved#characters'];
      res.writeHead(
        url.pathname !== pressurePath || req.method !== 'GET'
          ? 404
          : req.headers.accept !== 'application/json'
            ? 503
            : (upstreamStatus ??
              (valid.includes(url.searchParams.get('token') ?? '')
                ? 200
                : 401)),
        {
          'Content-Type': 'application/json',
          Location: '/backend/pressure?token=owner-a',
        },
      );
      res.end(
        upstreamBody ?? JSON.stringify({ pressure: { isAvailable: false } }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    config.browserlessApiUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/backend`;
    directory = await mkdtemp(join(tmpdir(), 'upload-auth-'));
    previousDirectory = process.env.BROWSERLESS_DOWNLOAD_DIR;
    process.env.BROWSERLESS_DOWNLOAD_DIR = directory;
  });

  afterEach(async () => {
    sinon.restore();
    clearResolverCache();
    if (previousDirectory === undefined)
      delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    else process.env.BROWSERLESS_DOWNLOAD_DIR = previousDirectory;
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  const app = () => {
    const server = new FastMCP({ name: 'test', version: '1.0.0' });
    registerUploadRoute(server, config);
    registerDownloadRoute(server, config);
    return server.getApp();
  };

  const upload = (
    route: ReturnType<FastMCP['getApp']>,
    data: string | ArrayBuffer,
  ) => {
    const body = new FormData();
    body.set('file', new File([data], 'fixture.bin'));
    return route.request('/upload?token=owner-a', { method: 'POST', body });
  };

  it('verifies uploads once through pressure, not the session-opening active check', async () => {
    const paths: string[] = [];
    upstream.on('request', (req) =>
      paths.push(new URL(req.url!, 'http://localhost').pathname),
    );
    expect((await upload(app(), 'upload bytes')).status).to.equal(200);
    expect(paths).to.deep.equal(['/backend/pressure']);
  });

  it('requires a token', async () => {
    const body = new FormData();
    body.set('file', new File(['data'], 'fixture.txt'));
    expect(
      (await app().request('/upload', { method: 'POST', body })).status,
    ).to.equal(401);
  });

  for (const [query, headers] of [
    ['?token=invented', {}],
    ['', { Authorization: 'Bearer invented' }],
    ['?token=owner-a', { Authorization: 'invented' }],
    ['?token=invented', { Authorization: 'Bearer header.payload.signature' }],
  ] as const) {
    it(`rejects invented upload credentials before writing bytes: ${query} ${JSON.stringify(headers)}`, async () => {
      const body = new FormData();
      body.set('file', new File(['attacker bytes'], 'untrusted.txt'));
      const response = await app().request(`/upload${query}`, {
        method: 'POST',
        body,
        headers,
      });
      expect(response.status).to.equal(401);
      expect(await response.json()).to.deep.equal({
        ok: false,
        error: 'Unauthorized',
      });
      expect(await readdir(directory)).to.deep.equal([]);
    });
  }

  for (const status of [401, 403]) {
    it(`does not stage bytes when verification returns ${status}`, async () => {
      upstreamStatus = status;
      expect((await upload(app(), 'unverified bytes')).status).to.equal(401);
      expect(await readdir(directory)).to.deep.equal([]);
    });
  }

  for (const status of [401, 403]) {
    it(`rejects ${status} despite unrelated usage metadata`, async () => {
      upstreamStatus = status;
      upstreamBody = JSON.stringify({
        error: { message: 'Unauthorized', units: 100 },
        credits: 0,
        units: 100,
        usage_limit: 1000,
      });
      expect((await upload(app(), 'unverified bytes')).status).to.equal(401);
      expect(await readdir(directory)).to.deep.equal([]);
    });
  }

  for (const status of [200, 404]) {
    it(`rejects an explicit unknown-token response with status ${status}`, async () => {
      upstreamStatus = status;
      upstreamBody = JSON.stringify({ error: 'unknown_token' });
      expect((await upload(app(), 'unverified bytes')).status).to.equal(401);
      expect(await readdir(directory)).to.deep.equal([]);
    });
  }

  for (const status of [302, 429, 500, 503]) {
    it(`preserves uploads with a warning when verification returns ${status}`, async () => {
      upstreamStatus = status;
      expect((await upload(app(), 'valid upload bytes')).status).to.equal(200);
      expect(await readdir(directory)).to.have.length(1);
      expect(warnings.args.flat().join(' ')).to.include('verification');
      expect(warnings.args.flat().join(' ')).not.to.include('owner-a');
    });
  }

  for (const [status, message] of [
    [401, 'Your account has run out of credits, please upgrade your plan'],
    [401, "You've reached the units usage limit allowed under our free plan"],
    [
      401,
      "You've reached your $10.00 overage spend limit for this billing period",
    ],
    [
      401,
      'Your account has exceeded its cloud unit allocation and is now in overage',
    ],
    [403, 'Account credit limit reached'],
    [
      401,
      JSON.stringify({
        error: { message: 'Account credit limit reached' },
        credits: 0,
      }),
    ],
    [403, JSON.stringify({ error: { code: 'CREDIT_LIMIT_REACHED' } })],
  ] as const) {
    it(`preserves uploads with a warning for a ${status} credit/limit response: ${message}`, async () => {
      upstreamStatus = status;
      upstreamBody = message;
      expect((await upload(app(), 'valid upload bytes')).status).to.equal(200);
      expect(await readdir(directory)).to.have.length(1);
      expect(warnings.args.flat().join(' ')).to.include('verification');
      expect(warnings.args.flat().join(' ')).not.to.include(message);
    });
  }

  for (const message of [
    'This request requires a cloud-unit account. Please contact support.',
    "Your plan doesn't support this endpoint.",
    'Unsupported account type',
    'Endpoint is not supported',
  ]) {
    it(`preserves uploads with a warning for an explicit 401 capability error: ${message}`, async () => {
      upstreamStatus = 401;
      upstreamBody = message;
      expect((await upload(app(), 'valid upload bytes')).status).to.equal(200);
      expect(await readdir(directory)).to.have.length(1);
      expect(warnings.args.flat().join(' ')).to.include('verification');
      expect(warnings.args.flat().join(' ')).not.to.include(message);
    });
  }

  it('still rejects explicit invalid keys in a capability-error response', async () => {
    upstreamStatus = 401;
    upstreamBody = 'Invalid API key. Unsupported account type.';
    expect((await upload(app(), 'unverified bytes')).status).to.equal(401);
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('bounds verification per route without rejecting uploads and releases slots after failures', async () => {
    const pending: ServerResponse[] = [];
    let reachedCapacity!: () => void;
    const capacityReached = new Promise<void>((resolve) => {
      reachedCapacity = resolve;
    });
    let holding = true;
    upstream.removeAllListeners('request');
    upstream.on('request', (_req, res) => {
      if (!holding) {
        res.writeHead(401).end();
        return;
      }
      pending.push(res);
      if (pending.length === 16) reachedCapacity();
    });
    const route = app();
    const requests = Array.from({ length: 16 }, () => upload(route, 'bytes'));
    await capacityReached;
    try {
      const overflow = await Promise.all(
        Array.from({ length: 4 }, () => upload(route, 'overflow bytes')),
      );
      expect(overflow.map((response) => response.status)).to.deep.equal(
        Array(4).fill(200),
      );
      expect(pending).to.have.length(16);
      expect(warnings.args.flat().join(' ')).to.include('capacity');
      expect(warnings.args.flat().join(' ')).not.to.include('owner-a');

      // A different route registration must not share the saturated cap.
      holding = false;
      expect((await upload(app(), 'other route bytes')).status).to.equal(401);
    } finally {
      holding = false;
      // Both early rejection and network failure must release their slots.
      pending.forEach((res, index) => {
        if (index % 2 === 0) res.writeHead(401).end();
        else res.destroy();
      });
      await Promise.all(requests);
    }
    const subsequent = await Promise.all(
      Array.from({ length: 16 }, () => upload(route, 'subsequent bytes')),
    );
    expect(subsequent.map((response) => response.status)).to.deep.equal(
      Array(16).fill(401),
    );
  });

  for (const failure of ['offline', 'timeout'] as const) {
    it(`preserves uploads with a warning when verification is ${failure}`, async () => {
      upstreamFailure = failure;
      expect((await upload(app(), 'upload bytes')).status).to.equal(200);
      expect(await readdir(directory)).to.have.length(1);
      expect(warnings.args.flat().join(' ')).to.include('verification');
    });
  }

  it('preserves verified OAuth uploads without backend availability', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('unavailable'));
    fetch.withArgs('/auth/v1/user').resolves(
      Response.json({
        id: 'upload-user',
        app_metadata: { accountId: 'upload-account', role: 'viewer' },
      }),
    );
    fetch
      .withArgs(
        '/rest/v1/accounts?account_id=eq.upload-account&select=api_key,email',
      )
      .resolves(
        Response.json([
          { api_key: 'resolved-upload-key', email: 'upload@example.test' },
        ]),
      );
    const route = app();
    const body = new FormData();
    body.set('file', new File(['oauth bytes'], 'oauth.txt'));
    const response = await route.request('/upload', {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer upload.payload.signature' },
    });
    expect(response.status).to.equal(200);
    expect(fetch.callCount).to.equal(2); // Identity lookup only, no API-key check.
    const { handle } = (await response.json()) as { handle: string };
    const id = handle.replace('browserless-download://', '');
    const download = await route.request(
      `/download/${id}?token=resolved-upload-key`,
    );
    expect(download.status).to.equal(200);
    expect(await download.text()).to.equal('oauth bytes');
  });

  for (const source of ['header', 'query'] as const) {
    it(`uses the allowed ${source} backend override with a base path and trailing slashes`, async () => {
      pressurePath = '/override/pressure';
      const override = new URL('/override//', config.browserlessApiUrl).href;
      const body = new FormData();
      body.set('file', new File(['override bytes'], 'fixture.bin'));
      const response = await app().request(
        `/upload?token=owner-a${source === 'query' ? `&browserlessUrl=${encodeURIComponent(override)}` : ''}`,
        {
          method: 'POST',
          body,
          headers:
            source === 'header' ? { 'x-browserless-api-url': override } : {},
        },
      );
      expect(response.status).to.equal(200);
      expect(warnings.called).to.equal(false);
    });
  }

  it('rejects an untrusted backend override before writing bytes', async () => {
    const body = new FormData();
    body.set('file', new File(['untrusted bytes'], 'fixture.bin'));
    const response = await app().request('/upload?token=owner-a', {
      method: 'POST',
      body,
      headers: { 'x-browserless-api-url': 'https://untrusted.example' },
    });
    expect(response.status).to.equal(400);
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('returns the existing shape and owner-scopes the handle', async () => {
    const route = app();
    const response = await upload(route, 'upload bytes');
    expect(response.status).to.equal(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).to.deep.equal(
      ['ok', 'handle', 'filename', 'mimeType', 'size'].sort(),
    );
    const id = (json.handle as string).replace('browserless-download://', '');
    expect(
      (await route.request(`/download/${id}?token=owner-b`)).status,
    ).to.equal(404);
    const owner = await route.request(`/download/${id}?token=owner-a`);
    expect(owner.status).to.equal(200);
    expect(await owner.text()).to.equal('upload bytes');
  });

  it('accepts bearer headers with URL-reserved characters in the owner token', async () => {
    const route = app();
    const token = 'owner+with&reserved#characters';
    const body = new FormData();
    body.set('file', new File(['upload bytes'], 'fixture.bin'));
    const response = await route.request('/upload', {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${token}` },
    });
    const { handle } = (await response.json()) as { handle: string };
    const id = handle.replace('browserless-download://', '');

    const owner = await route.request(
      `/download/${id}?token=${encodeURIComponent(token)}`,
    );
    expect(owner.status).to.equal(200);
    expect(await owner.text()).to.equal('upload bytes');
  });

  it('rejects files over 50 MiB', async () => {
    const response = await upload(app(), new ArrayBuffer(51 * 1024 * 1024));
    expect(response.status).to.equal(413);
  });

  it('handles missing and empty files without a server error', async () => {
    const route = app();
    const missing = await route.request('/upload?token=owner-a', {
      method: 'POST',
      body: new FormData(),
    });
    expect(missing.status).to.equal(400);

    const empty = new FormData();
    empty.set('file', new File([], 'empty.txt'));
    const response = await route.request('/upload?token=owner-a', {
      method: 'POST',
      body: empty,
    });
    expect(response.status).to.not.equal(500);
  });
});
