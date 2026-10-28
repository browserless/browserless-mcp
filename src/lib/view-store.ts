import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { UserError } from 'fastmcp';
import type { ContentResult } from 'fastmcp';
import type { ReplayArtifact } from './session-replay-artifact.js';
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
}

export class ViewStore {
  private views = new Map<string, StoredView>();
  private bytes = 0;

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
    if (!view || view.owner !== owner || view.expires <= this.now())
      throw new UserError(VIEW_UNAVAILABLE);
    return view;
  }

  show(ref: string, owner: string): ContentResult {
    const view = this.require(ref, owner);
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
    for (const ref of this.views.keys()) this.drop(ref);
  }
}

export const replayViews = new ViewStore();
