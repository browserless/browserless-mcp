import { z } from 'zod';
import type { ContentResult } from 'fastmcp';
import type { LiveURLCreated } from '../@types/types.js';
import { LIVE_VIEWER_PATH } from './view-schemas.js';

export const LIVE_URL_URI = 'ui://browserless/live-url/v1.html';
const ViewerURLSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' || (local && url.protocol === 'http:'))
    );
  });
export const LiveViewerURLSchema = ViewerURLSchema.refine((value) =>
  LIVE_VIEWER_PATH.test(new URL(value).pathname),
);

export function publicViewerOrigin(value: string): URL {
  const origin = new URL(ViewerURLSchema.parse(value));
  if (origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('Invalid public Browserless origin.');
  return origin;
}

export function verifiedLiveViewerURL(
  value: string,
  apiUrl: string,
  liveURLId: string,
  publicOrigin?: URL,
): URL {
  const url = new URL(LiveViewerURLSchema.parse(value));
  if (
    url.origin !== new URL(apiUrl).origin ||
    url.searchParams.get('i') !== liveURLId
  )
    throw new Error('Invalid viewer origin or ID');
  if (publicOrigin) {
    url.protocol = publicOrigin.protocol;
    url.hostname = publicOrigin.hostname;
    url.port = publicOrigin.port;
    LiveViewerURLSchema.parse(url.href);
  }
  return url;
}

export const LiveURLViewSchema = z.object({
  kind: z.literal('live-url'),
  action: z.literal('create'),
  browserId: z.string().min(1),
  liveURLId: z.string().min(1),
  timeout: z.number().finite().positive().optional(),
  browserExpiresAt: z.number().finite().positive().nullable().optional(),
  targetId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  remainingMs: z.number().finite().nonnegative().max(900_000),
});

// Direct viewers carry their URL in this tool result, not a store.
export function liveURLView(
  result: LiveURLCreated,
  browserId: string,
  apiUrl: string,
  started: number,
  publicUrl?: string,
): ContentResult {
  let fallbackAction = 'unavailable';
  try {
    const url = verifiedLiveViewerURL(
      result.liveURL,
      apiUrl,
      result.liveURLId,
      publicUrl ? publicViewerOrigin(publicUrl) : undefined,
    );
    const expires = Math.min(
      started + 900_000,
      started + (result.timeout ?? 900_000),
      result.browserExpiresAt ?? Infinity,
    );
    const remainingMs = expires - Date.now();
    if (remainingMs <= 0) {
      fallbackAction = 'expired';
      throw new Error('Expired viewer');
    }
    const view = LiveURLViewSchema.parse({
      kind: 'live-url',
      action: 'create',
      browserId,
      liveURLId: result.liveURLId,
      timeout: result.timeout,
      browserExpiresAt: result.browserExpiresAt,
      targetId: result.targetId,
      expiresAt: new Date(expires).toISOString(),
      remainingMs,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Live viewer created for browser ${browserId}. Viewer ID: ${result.liveURLId}. Creating a viewer does not keep the browser alive or pause automation.`,
        },
      ],
      structuredContent: view,
      _meta: { payload: { liveURL: url.href } },
    };
  } catch {
    // A rendering failure must not turn an already successful mutation into an
    // error (and encourage the caller to create another viewer).
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: { kind: 'live-url', action: fallbackAction },
    };
  }
}
