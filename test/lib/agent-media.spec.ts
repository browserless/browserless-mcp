import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FastMCP } from 'fastmcp';
import {
  ViewStore,
  replayViews,
  VIEW_TTL_MS,
  VIEW_UNAVAILABLE,
} from '../../src/lib/view-store.js';
import {
  mediaOrigin,
  prepareAgentMedia,
  matchesMediaType,
  type MediaInput,
} from '../../src/lib/agent-media.js';
import {
  storeDownload,
  downloadOwner,
  clearSession,
  consumeDownload,
} from '../../src/lib/download-store.js';
import {
  registerMediaPreviewRoute,
  byteRange,
} from '../../src/resources/media-preview.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmhsAAAAASUVORK5CYII=',
  'base64',
);
// Container marker for byte-transport tests, not a playable video fixture.
const webm = Buffer.concat([
  Buffer.from([26, 69, 223, 163]),
  Buffer.from('webm opaque recording bytes'),
]);
const input = (): MediaInput => ({
  type: 'image',
  mimeType: 'image/png',
  body: png,
  label: 'Screenshot 1',
  rationale: 'Inspect the page.',
  commandIndex: 2,
});
const origin = 'https://mcp.example';

describe('agent media views and preview transport', () => {
  let store: ViewStore, now: number;
  beforeEach(() => {
    now = Date.now();
    store = new ViewStore({ now: () => now });
  });
  afterEach(async () => {
    await store.clear();
    await replayViews.clear();
    clearSession('media-test');
  });

  it('cleans same-PID and exited-process previews at startup while preserving live previews', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-startup-'));
    try {
      await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import assert from 'node:assert/strict';
            import { access, mkdir } from 'node:fs/promises';
            import { tmpdir } from 'node:os';
            import { join } from 'node:path';
            const { ViewStore } = await import(process.argv[1]);
            const root = join(tmpdir(), 'browserless-mcp-previews');
            const own = join(root, process.pid + '-view_aaaaaaaa');
            const live = join(root, process.ppid + '-view_bbbbbbbb');
            const exited = join(root, '2147483647-view_cccccccc');
            assert.throws(() => process.kill(2147483647, 0), { code: 'ESRCH' });
            await Promise.all([own, live, exited].map(path => mkdir(path, { recursive: true })));
            const store = new ViewStore();
            const input = { type: 'image', mimeType: 'image/png', body: Buffer.from('fixture'), label: 'Capture', rationale: '', commandIndex: 1 };
            const first = await store.prepareMedia('owner', [input]);
            assert.ok(first);
            await assert.rejects(access(own), { code: 'ENOENT' });
            await assert.rejects(access(exited), { code: 'ENOENT' });
            await access(live);
            const payload = store.show(first.viewRef, 'owner', 'https://mcp.example')._meta.payload;
            const cap = new URL(payload.artifacts[0].previewUrl).pathname.split('/').at(-1);
            const current = store.preview(cap).path;
            await store.prepareMedia('owner', [input]);
            await access(current);
            await store.clear();
          `,
          new URL('../../src/lib/view-store.js', import.meta.url).href,
        ],
        {
          env: {
            ...process.env,
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('validates media origins and rejects script/HTML masquerading as captures', () => {
    assert.equal(
      mediaOrigin({ transport: 'stdio', mcpBaseUrl: origin }),
      undefined,
    );
    assert.equal(
      mediaOrigin({
        transport: 'httpStream',
        mcpBaseUrl: 'https://secret@example.com',
      }),
      undefined,
    );
    assert.equal(
      mediaOrigin({
        transport: 'httpStream',
        mcpBaseUrl: 'http://remote.example',
      }),
      undefined,
    );
    assert.equal(
      mediaOrigin({
        transport: 'httpStream',
        mcpBaseUrl: 'http://127.0.0.1:1234',
      }),
      'http://127.0.0.1:1234',
    );
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/webm',
    ] as const)
      assert.equal(
        matchesMediaType(Buffer.from('<svg onload="alert(1)">'), type),
        false,
      );
    assert.equal(matchesMediaType(png, 'image/png'), true);
  });

  it('prepares owned snapshots with bounded metadata and no private paths in results', async () => {
    const prepared = (await store.prepareMedia('alice', [input()]))!;
    assert.equal(prepared.kind, 'agent-media');
    const shown = store.show(prepared.viewRef, 'alice', origin);
    assert.equal(
      ShowOutputSchema.parse(shown.structuredContent).kind,
      'agent-media',
    );
    assert.equal(
      JSON.stringify(shown.structuredContent).includes('/preview/'),
      false,
    );
    const asset = (shown._meta!.payload as any).artifacts[0];
    assert.equal(asset.path, undefined);
    assert.equal(asset.capability, undefined);
    assert.equal(asset.mimeType, 'image/png');
    assert.equal(asset.bytes, png.length);
    assert.throws(() => store.show(prepared.viewRef, 'bob', origin), {
      message: VIEW_UNAVAILABLE,
    });
    assert.throws(() => store.show(prepared.viewRef, 'alice'), {
      message: VIEW_UNAVAILABLE,
    });
    await assert.rejects(
      () => store.read(prepared.viewRef, 'alice', 'identity'),
      { message: VIEW_UNAVAILABLE },
    );
    const cap = new URL(asset.previewUrl).pathname.split('/').at(-1)!;
    assert.deepEqual(await readFile(store.preview(cap)!.path), png);
    now += VIEW_TTL_MS;
    assert.equal(store.preview(cap), undefined);
    assert.throws(() => store.show(prepared.viewRef, 'alice', origin), {
      message: VIEW_UNAVAILABLE,
    });
  });

  it('supports repeatable GET, HEAD, Range, Save, expiry, and missing bytes', async () => {
    const prepared = (await store.prepareMedia('alice', [input()]))!;
    const asset = (
      store.show(prepared.viewRef, 'alice', origin)._meta!.payload as any
    ).artifacts[0];
    const server = new FastMCP({ name: 'media-test', version: '1.0.0' });
    registerMediaPreviewRoute(server, store);
    const app = server.getApp();
    for (let index = 0; index < 2; index++) {
      const response = await app.request(asset.previewUrl);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    const head = await app.request(asset.previewUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get('content-length'), String(png.length));
    const part = await app.request(asset.previewUrl, {
      headers: { Range: 'bytes=1-3' },
    });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(1, 4));
    assert.equal(
      (
        await app.request(asset.previewUrl, {
          headers: { Range: 'bytes=999999-' },
        })
      ).status,
      416,
    );
    const save = await app.request(asset.saveUrl);
    assert.match(
      save.headers.get('content-disposition')!,
      /^attachment; filename="capture-2.png"$/,
    );
    await save.arrayBuffer();
    assert.equal(
      (await app.request(origin + '/preview/not-a-capability')).status,
      404,
    );
    const cap = new URL(asset.previewUrl).pathname.split('/').at(-1)!;
    await unlink(store.preview(cap)!.path);
    assert.equal((await app.request(asset.previewUrl)).status, 404);
    now += VIEW_TTL_MS;
    assert.equal((await app.request(asset.previewUrl)).status, 404);
  });

  it('handles suffix/open-ended ranges and ignores unsupported multi-range requests', () => {
    assert.deepEqual(byteRange('bytes=-3', 10), [7, 9]);
    assert.deepEqual(byteRange('bytes=3-', 10), [3, 9]);
    assert.deepEqual(byteRange('bytes=0-999', 10), [0, 9]);
    assert.equal(byteRange('bytes=-0', 10), null);
    assert.equal(byteRange('bytes=5-2', 10), null);
    assert.equal(byteRange('bytes=999999999999999999999-', 10), null);
    assert.deepEqual(byteRange('bytes=0-1,4-5', 10), [0, 9]);
  });

  it('preserves recording previews after the single-use download and MCP session cleanup', async () => {
    const record = await storeDownload(
      'recording.webm',
      'video/webm',
      webm,
      downloadOwner('token'),
      'media-test',
    );
    const prepared = (await prepareAgentMedia('alice', 'token', {
      content: [],
      results: [
        { method: 'stopRecording', params: {}, result: { download: record } },
      ],
    }))!;
    const asset = (
      replayViews.show(prepared.viewRef, 'alice', origin)._meta!.payload as any
    ).artifacts[0];
    const cap = new URL(asset.previewUrl).pathname.split('/').at(-1)!;
    assert.deepEqual(await readFile(replayViews.preview(cap)!.path), webm);
    const consumed = consumeDownload(record.id, downloadOwner('token'))!;
    await unlink(consumed.path);
    clearSession('media-test');
    assert.deepEqual(await readFile(replayViews.preview(cap)!.path), webm);
    assert.equal(consumeDownload(record.id, downloadOwner('token')), undefined);
  });

  it('collects earlier screenshots without rerunning commands or leaking URL credentials', async () => {
    const prepared = (await prepareAgentMedia(
      'alice',
      'token',
      {
        content: [],
        results: [
          {
            method: 'screenshot',
            params: {},
            result: { base64: png.toString('base64') },
            pageUrl: 'https://user:password@example.com/path?token=secret',
          },
          { method: 'text', params: {}, result: { text: 'Not media' } },
        ],
      },
      'Check the result.',
    ))!;
    assert.deepEqual(prepared.data, {
      website: 'example.com',
      imageCount: 1,
      videoCount: 0,
    });
    const payload = replayViews.show(prepared.viewRef, 'alice', origin)._meta!
      .payload as any;
    assert.equal(payload.artifacts[0].width, 1);
    assert.equal(payload.artifacts[0].commandIndex, 1);
    assert.equal(/password|secret|base64/.test(JSON.stringify(payload)), false);
    assert.equal(
      await prepareAgentMedia('alice', 'token', {
        content: [],
        results: [
          {
            method: 'screenshot',
            params: {},
            result: { base64: Buffer.from('<html>').toString('base64') },
          },
        ],
      }),
      undefined,
    );
  });

  it('bounds galleries and concurrent reservations without evicting another owner', async () => {
    assert.equal(
      await store.prepareMedia('alice', Array.from({ length: 13 }, input)),
      undefined,
    );
    store = new ViewStore({ maxEntries: 1 });
    const [a, b] = await Promise.all([
      store.prepareMedia('alice', [input()]),
      store.prepareMedia('bob', [input()]),
    ]);
    assert.ok(a);
    assert.equal(b, undefined);
    assert.equal(
      store.show(a.viewRef, 'alice', origin).structuredContent!.viewRef,
      a.viewRef,
    );
    const asset = (store.show(a.viewRef, 'alice', origin)._meta!.payload as any)
      .artifacts[0];
    const cap = new URL(asset.previewUrl).pathname.split('/').at(-1)!;
    const path = store.preview(cap)!.path;
    await store.clear();
    await assert.rejects(() => readFile(path));
    assert.equal(store.preview(cap), undefined);
  });
});
