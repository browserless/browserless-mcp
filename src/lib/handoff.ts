import { randomUUID } from 'node:crypto';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { ApiClient, ActiveSession, McpConfig } from '../@types/types.js';
import {
  getActiveSessionByHandle,
  startHumanHandoff,
  releaseHumanHandoff,
} from './agent-client.js';
import { HandoffStateSchema, type PreparedView } from './view-schemas.js';
import { VIEW_UNAVAILABLE } from './view-store.js';

const MintedSchema = z.object({
  browserId: z.string().min(1).max(256),
  liveURLId: z.string().min(1).max(256),
  liveURL: z.string().url().max(4096),
  timeout: z.number().finite().positive().max(900_000),
  browserExpiresAt: z.number().finite().positive().nullable().optional(),
});
type Handoff = {
  owner: string;
  session: ActiveSession;
  prepared: PreparedView;
  liveURL: string;
  browserId: string;
  liveURLId: string;
  expires: number;
  closed?: boolean;
};
const views = new Map<string, Handoff>();
const current = new WeakMap<ActiveSession, Handoff>();

export function handoffOrigins(
  config: Pick<McpConfig, 'browserlessApiUrl' | 'publicBrowserlessUrl'>,
) {
  return [
    ...new Set([
      new URL(config.browserlessApiUrl).origin,
      ...(config.publicBrowserlessUrl
        ? [new URL(config.publicBrowserlessUrl).origin]
        : []),
      'https://*.browserless.io',
      'https://browserless.io',
    ]),
  ];
}
export function findHandoff(ref: string, owner: string): Handoff | undefined {
  const view = views.get(ref);
  if (!view || view.owner !== owner) return;
  if (view.expires <= Date.now()) {
    views.delete(ref);
    throw new UserError(VIEW_UNAVAILABLE);
  }
  return view;
}
export async function readHandoff(view: Handoff, client: ApiClient) {
  // A cancelled widget must be able to stop polling after its driver is closed.
  if (view.closed)
    return {
      status: 'closed' as const,
      reason: 'closed' as const,
      interactable: false,
      viewerCount: 0,
      expiresAt: view.expires,
      sessionId: view.session.handle,
    };
  // Never reconnect, adopt, touch the idle clock, or launch a replacement browser.
  const active = getActiveSessionByHandle(
    view.session.handle,
    view.session.apiUrl,
    view.session.token,
    view.session.userId,
    false,
  );
  if (active !== view.session) throw new UserError(VIEW_UNAVAILABLE);
  const state = HandoffStateSchema.parse(
    await client.getLiveURL(view.browserId, view.liveURLId),
  );
  view.expires = Math.min(view.expires, state.expiresAt);
  view.prepared.expiresAt = new Date(view.expires).toISOString();
  if (
    (state.status === 'open' &&
      (!state.interactable || state.reason !== null)) ||
    (state.status === 'expired' && state.reason !== 'timeout') ||
    (state.status === 'closed' &&
      (state.reason === null || state.reason === 'timeout'))
  )
    throw new UserError(VIEW_UNAVAILABLE);
  if (
    state.status === 'closed' &&
    state.reason === 'userDone' &&
    current.get(view.session) === view
  )
    releaseHumanHandoff(view.session, view.prepared.viewRef);
  return {
    ...state,
    sessionId: view.session.handle,
    expiresAt: Math.min(view.expires, state.expiresAt),
  };
}
export async function prepareHandoff(
  session: ActiveSession,
  owner: string,
  client: ApiClient,
  instructions: string,
  timeout = 300_000,
  publicUrl?: string,
) {
  let publicOrigin: URL | undefined;
  if (publicUrl) {
    publicOrigin = new URL(publicUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(
      publicOrigin.hostname,
    );
    if (
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.search ||
      publicOrigin.hash ||
      publicOrigin.pathname !== '/' ||
      (publicOrigin.protocol !== 'https:' &&
        !(local && publicOrigin.protocol === 'http:'))
    )
      throw new UserError('Invalid public Browserless origin.');
  }
  for (const [ref, view] of views)
    if (view.expires <= Date.now() || view.closed) views.delete(ref);
  if (views.size >= 16)
    throw new UserError(
      'Too many handoff views. Wait for an existing view to expire.',
    );
  const prior = current.get(session);
  if (prior) {
    const state = await readHandoff(prior, client);
    if (state.status === 'open')
      throw new UserError(
        'A human handoff is already waiting. Reuse its viewRef.',
      );
    releaseHumanHandoff(session, prior.prepared.viewRef);
  }
  const started = Date.now();
  const ref = `view_${randomUUID()}`;
  const options = {
    humanHandoff: true,
    timeout,
    interactable: true,
    resizable: true,
    showTimer: true,
    instructions,
    showBrowserInterface: true,
  };
  const response = await startHumanHandoff(
    session,
    options,
    ref,
    async (result) => {
      const minted = MintedSchema.parse(result);
      const state = HandoffStateSchema.parse(
        await client.getLiveURL(minted.browserId, minted.liveURLId),
      );
      if (state.status === 'open')
        await client.closeLiveURL(minted.browserId, minted.liveURLId);
      const view = views.get(ref);
      if (view) view.closed = true;
      if (current.get(session)?.prepared.viewRef === ref)
        current.delete(session);
    },
    async (response, request) => {
      if (MintedSchema.safeParse(response.result).success) return response;
      const legacy = MintedSchema.omit({ browserId: true })
        .extend({
          targetId: z.string().min(1).max(256),
        })
        .parse(response.result);
      // Older runtimes reuse a page's live ID. Close it before publishing a
      // fresh capability, while the same-socket handoff guard stays held.
      const closed = await request('closeLiveURL', {
        liveURLId: legacy.liveURLId,
      });
      if (closed.error)
        throw new UserError('Unable to replace the previous live viewer.');
      const browserId = await client.getBrowserIdForTarget(legacy.targetId);
      if (!browserId)
        throw new UserError(
          'This backend cannot resolve the owned handoff browser.',
        );
      const next = await request('liveURL', options);
      if (next.error) return next;
      const minted = MintedSchema.parse({
        ...(next.result as object),
        browserId,
      });
      if (
        minted.liveURLId === legacy.liveURLId ||
        (next.result as { targetId?: string }).targetId !== legacy.targetId
      ) {
        await request('closeLiveURL', { liveURLId: minted.liveURLId });
        throw new UserError(
          'The handoff target changed while preparing its viewer. Retry with the existing browser.',
        );
      }
      return { ...next, result: { ...(next.result as object), browserId } };
    },
  );
  if (response.error)
    throw new UserError(
      (response.error.message ===
      'A human handoff is already active for this page.'
        ? 'An earlier human handoff is still active for this page. Complete or explicitly close its viewer before creating another. The browser remains open.'
        : 'Unable to create the human handoff. The browser remains open.') +
        ' Never ask the user to paste passwords or verification codes into chat.',
    );
  let minted: z.infer<typeof MintedSchema>;
  try {
    minted = MintedSchema.parse(response.result);
    const url = new URL(minted.liveURL);
    const api = new URL(session.apiUrl);
    if (
      url.origin !== api.origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      !/^\/live(?:\/|$)/.test(url.pathname) ||
      url.searchParams.get('i') !== minted.liveURLId
    )
      throw new Error('Invalid live viewer URL');
    if (publicOrigin) {
      url.protocol = publicOrigin.protocol;
      url.hostname = publicOrigin.hostname;
      url.port = publicOrigin.port;
    }
    const expires = Math.min(
      started + minted.timeout,
      minted.browserExpiresAt ?? Infinity,
    );
    if (expires <= Date.now()) throw new Error('Expired');
    if (views.size >= 16) throw new Error('Handoff view limit reached.');
    const prepared: PreparedView = {
      viewRef: ref,
      kind: 'handoff',
      expiresAt: new Date(expires).toISOString(),
      summary:
        'Human input is needed. Complete the step in the viewer, choose Done, then return to the conversation.',
      data: { sessionId: session.handle, instructions },
    };
    const view: Handoff = {
      owner,
      session,
      prepared,
      liveURL: url.href,
      browserId: minted.browserId,
      liveURLId: minted.liveURLId,
      expires,
    };
    views.set(ref, view);
    current.set(session, view);
    return prepared;
  } catch {
    releaseHumanHandoff(session, ref);
    throw new UserError(
      'This backend cannot prepare a verified inline handoff. Update the backend, or use the existing liveURL command for an external viewer. The browser remains open.',
    );
  }
}
export function clearHandoffs() {
  for (const view of views.values()) {
    releaseHumanHandoff(view.session, view.prepared.viewRef);
    current.delete(view.session);
  }
  views.clear();
}
