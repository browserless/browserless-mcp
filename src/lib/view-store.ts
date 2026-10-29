import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { UserError } from 'fastmcp';
import type { ContentResult } from 'fastmcp';
import type { ReplayArtifact } from './session-replay-artifact.js';
import type { MediaInput } from './agent-media.js';
import {
  ReplayPayloadSchema,
  VIEW_CHUNK_MAX_BYTES,
  VIEW_DATA_MAX_BYTES,
  VIEW_RESULT_MAX_BYTES,
  type PreparedView,
} from './view-schemas.js';

export const VIEW_UNAVAILABLE =
  'This view is unavailable. Run the original data tool again to prepare a new view.';
export const VIEW_TTL_MS = 15 * 60 * 1000;
const PAGE_BYTES = 72 * 1024; // 96 KiB base64, leaving room for the result envelope.
const gzipAsync = promisify(gzip);
type Encoding = 'identity' | 'gzip';
type StoredMedia = Omit<MediaInput, 'body'> & {
  id: string;
  capability: string;
  path: string;
  bytes: number;
};

const previewRoot = join(tmpdir(), 'browserless-mcp-previews');
let directoryReady: Promise<void> | undefined;
function prepareDirectory() {
  return (directoryReady ??= (async () => {
    await mkdir(previewRoot, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(previewRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+-view_[a-f0-9-]+$/.test(entry.name))
        continue;
      const pid = Number(entry.name.split('-')[0]);
      let stale = pid === process.pid;
      if (!stale) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
      if (stale)
        await rm(join(previewRoot, entry.name), {
          recursive: true,
          force: true,
        });
    }
  })().catch((error) => {
    directoryReady = undefined;
    throw error;
  }));
}

interface StoredView {
  prepared: PreparedView;
  owner: string;
  sessionId: string;
  expires: number;
  json: Buffer;
  gzip?: Buffer;
  gzipPromise?: Promise<void>;
  cursors: Partial<Record<Encoding, string[]>>;
  timer: ReturnType<typeof setTimeout>;
  media?: StoredMedia[];
  directory?: string;
  writes?: Promise<void>;
  ready?: boolean;
}

export class ViewStore {
  private views = new Map<string, StoredView>();
  private bytes = 0;
  private capabilities = new Map<string, string>();

  // ponytail: process-local snapshots; verify single-process routing or use shared storage before scaling.
  constructor(
    private options: {
      now?: () => number;
      maxEntries?: number;
      maxBytes?: number;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private drop(ref: string) {
    const view = this.views.get(ref);
    if (!view) return;
    clearTimeout(view.timer);
    this.bytes -= view.json.length + (view.gzip?.length ?? 0);
    this.views.delete(ref);
    if (view.media) {
      for (const asset of view.media)
        this.capabilities.delete(asset.capability);
      const bytes = view.media.reduce((total, asset) => total + asset.bytes, 0);
      // Hold the disk reservation until in-flight writes and deletion finish.
      return (view.writes ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await rm(view.directory!, { recursive: true, force: true });
          this.bytes -= bytes;
        })
        .catch(() => {
          /* Keep failed-deletion bytes reserved until restart cleanup. */
        });
    }
    return undefined;
  }

  async prepareMedia(
    owner: string,
    inputs: MediaInput[],
  ): Promise<PreparedView | undefined> {
    if (
      !inputs.length ||
      inputs.length > 12 ||
      inputs.some(
        (item) => !item.body.length || item.body.length > VIEW_DATA_MAX_BYTES,
      )
    )
      return;
    const ref = `view_${randomUUID()}`,
      expires = this.now() + VIEW_TTL_MS;
    const directory = join(previewRoot, `${process.pid}-${ref}`);
    const media: StoredMedia[] = inputs.map((item) => {
      const id = randomUUID();
      return {
        type: item.type,
        mimeType: item.mimeType,
        label: item.label.slice(0, 128),
        rationale: item.rationale.slice(0, 500),
        commandIndex: item.commandIndex,
        ...(item.website ? { website: item.website.slice(0, 256) } : {}),
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        id,
        path: join(directory, id),
        bytes: item.body.length,
        capability: randomBytes(32).toString('base64url'),
      };
    });
    const imageCount = media.filter((item) => item.type === 'image').length,
      videoCount = media.length - imageCount;
    const sites = new Set(media.map((item) => item.website));
    const website = sites.size === 1 ? media[0].website : undefined;
    const prepared: PreparedView = {
      viewRef: ref,
      kind: 'agent-media',
      summary: `${imageCount} screenshots and ${videoCount} recordings from this call.`,
      expiresAt: new Date(expires).toISOString(),
      data: { ...(website ? { website } : {}), imageCount, videoCount },
    };
    const json = Buffer.from(
      JSON.stringify({
        artifacts: media.map(
          ({ path: _path, capability: _cap, ...item }) => item,
        ),
      }),
    );
    const needed =
      json.length + media.reduce((total, item) => total + item.bytes, 0);
    if (!this.room(needed, owner)) return;
    while (this.views.size >= (this.options.maxEntries ?? 16)) {
      const victim = [...this.views].find(
        ([, view]) => view.owner === owner,
      )?.[0];
      if (!victim) return;
      this.drop(victim);
    }
    const timer = setTimeout(() => this.drop(ref), VIEW_TTL_MS);
    timer.unref?.();
    const view: StoredView = {
      prepared,
      owner,
      sessionId: '',
      expires,
      json,
      timer,
      cursors: {},
      media,
      directory,
      ready: false,
    };
    this.bytes += needed;
    this.views.set(ref, view);
    view.writes = (async () => {
      await prepareDirectory();
      await mkdir(directory, { mode: 0o700 });
      for (const [index, item] of inputs.entries())
        await writeFile(media[index].path, item.body, {
          mode: 0o600,
          flag: 'wx',
        });
    })();
    try {
      await view.writes;
      if (this.views.get(ref) !== view || expires <= this.now()) {
        this.drop(ref);
        return;
      }
      view.ready = true;
      for (const item of media) this.capabilities.set(item.capability, ref);
      return structuredClone(prepared);
    } catch {
      this.drop(ref);
      return;
    }
  }

  preview(capability: string): (StoredMedia & { expires: number }) | undefined {
    const ref = this.capabilities.get(capability),
      view = ref && this.views.get(ref);
    if (!view || view.expires <= this.now()) {
      if (ref) this.drop(ref);
      return;
    }
    const asset = view.media?.find((item) => item.capability === capability);
    return asset && { ...asset, expires: view.expires };
  }

  private room(extra: number, owner: string, keep?: string): boolean {
    for (const [ref, view] of this.views) {
      if (view.expires <= this.now()) this.drop(ref);
    }
    const maxBytes = this.options.maxBytes ?? 128 * 1024 * 1024;
    if (extra > maxBytes) return false;
    for (const [ref, view] of this.views) {
      if (this.bytes + extra <= maxBytes) break;
      if (ref !== keep && view.owner === owner) this.drop(ref);
    }
    return this.bytes + extra <= maxBytes;
  }

  prepare(owner: string, artifact: ReplayArtifact): PreparedView | undefined {
    if (!ReplayPayloadSchema.safeParse(artifact).success) return undefined;
    const json = Buffer.from(JSON.stringify(artifact));
    if (json.length > VIEW_DATA_MAX_BYTES || !this.room(json.length, owner))
      return undefined;
    while (this.views.size >= (this.options.maxEntries ?? 16)) {
      const victim = [...this.views].find(
        ([, view]) => view.owner === owner,
      )?.[0];
      if (!victim) return undefined;
      this.drop(victim);
    }
    const events = artifact.events as Array<{ timestamp: number }>;
    const duration = Math.max(
      0,
      events.at(-1)!.timestamp - events[0].timestamp,
    );
    let website: string | undefined;
    try {
      website = new URL(artifact.website ?? '').hostname.slice(0, 256);
    } catch {
      /* A recording need not have a URL. */
    }
    const viewRef = `view_${randomUUID()}`;
    const expires = this.now() + VIEW_TTL_MS;
    const prepared: PreparedView = {
      viewRef,
      kind: 'replay',
      summary: `Session replay${website ? ` for ${website}` : ''}: ${Math.round(duration / 1000)} seconds.`,
      expiresAt: new Date(expires).toISOString(),
      data: {
        ...(website ? { website } : {}),
        duration,
        eventCount: events.length,
      },
    };
    const timer = setTimeout(() => this.drop(viewRef), VIEW_TTL_MS);
    timer.unref?.();
    this.views.set(viewRef, {
      prepared,
      owner,
      sessionId: artifact.sessionId,
      expires,
      json,
      timer,
      cursors: {},
    });
    this.bytes += json.length;
    return structuredClone(prepared);
  }

  require(ref: string, owner: string): StoredView {
    const view = this.views.get(ref);
    if (view && view.expires <= this.now()) this.drop(ref);
    if (
      !view ||
      view.ready === false ||
      view.owner !== owner ||
      view.expires <= this.now()
    )
      throw new UserError(VIEW_UNAVAILABLE);
    return view;
  }

  show(ref: string, owner: string, origin?: string): ContentResult {
    const view = this.require(ref, owner);
    if (view.media) {
      if (!origin) throw new UserError(VIEW_UNAVAILABLE);
      const payload = JSON.parse(view.json.toString('utf8'));
      payload.mediaOrigin = origin;
      payload.artifacts = payload.artifacts.map((item: { id: string }) => {
        const asset = view.media!.find((asset) => asset.id === item.id)!;
        const previewUrl = `${origin}/preview/${asset.capability}`;
        return { ...item, previewUrl, saveUrl: `${previewUrl}?download=1` };
      });
      const result: ContentResult = {
        content: [{ type: 'text', text: view.prepared.summary }],
        structuredContent: structuredClone(view.prepared),
        _meta: { payload },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > VIEW_RESULT_MAX_BYTES)
        throw new UserError(VIEW_UNAVAILABLE);
      return result;
    }
    const result: ContentResult = {
      content: [{ type: 'text', text: view.prepared.summary }],
      structuredContent: structuredClone(view.prepared),
      _meta: { payload: null },
    };
    // Replace the four bytes of `null` with the already serialized recording.
    if (
      Buffer.byteLength(JSON.stringify(result)) - 4 + view.json.length >
      VIEW_RESULT_MAX_BYTES
    ) {
      result._meta = {
        source: {
          viewRef: ref,
          bytes: view.json.length,
          encoding: 'base64-json',
        },
      };
    } else {
      result._meta = { payload: JSON.parse(view.json.toString('utf8')) };
    }
    return result;
  }

  async read(
    ref: string,
    owner: string,
    encoding: Encoding,
    cursor?: string,
  ): Promise<ContentResult> {
    const view = this.require(ref, owner);
    if (view.media) throw new UserError(VIEW_UNAVAILABLE);
    if (encoding === 'gzip' && !view.gzip) {
      await (view.gzipPromise ??= gzipAsync(view.json)
        .then((compressed) => {
          this.require(ref, owner);
          if (!this.room(compressed.length, owner, ref))
            throw new UserError(VIEW_UNAVAILABLE);
          this.require(ref, owner);
          view.gzip = compressed;
          this.bytes += compressed.length;
        })
        .finally(() => {
          view.gzipPromise = undefined;
        }));
      this.require(ref, owner);
    }
    const bytes = encoding === 'gzip' ? view.gzip! : view.json;
    const cursors = (view.cursors[encoding] ??= Array.from(
      { length: Math.ceil(bytes.length / PAGE_BYTES) },
      () => randomUUID(),
    ));
    const page = cursor ? cursors.indexOf(cursor) : 0;
    if (page < 0) throw new UserError(VIEW_UNAVAILABLE);
    const nextCursor = cursors[page + 1];
    const result: ContentResult = {
      content: [],
      structuredContent: {
        complete: !nextCursor,
        ...(nextCursor ? { nextCursor } : {}),
      },
      _meta: {
        encoding: encoding === 'gzip' ? 'base64-gzip-json' : 'base64-json',
        totalChars: Math.ceil(bytes.length / 3) * 4,
        data: bytes
          .subarray(page * PAGE_BYTES, (page + 1) * PAGE_BYTES)
          .toString('base64'),
      },
    };
    if (Buffer.byteLength(JSON.stringify(result)) > VIEW_CHUNK_MAX_BYTES)
      throw new UserError(VIEW_UNAVAILABLE);
    return result;
  }

  clear() {
    return Promise.all(
      [...this.views.keys()].map((ref) => this.drop(ref)),
    ).then(() => {});
  }
}

export const replayViews = new ViewStore();
