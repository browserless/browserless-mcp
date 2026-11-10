import { randomUUID } from 'node:crypto';
import { UserError, type ContentResult } from 'fastmcp';
import type { PerformanceParams } from '../@types/types.js';

export const PERFORMANCE_AUDIT_TTL_MS = 15 * 60 * 1000;
const unavailable = () =>
  new UserError(
    'This performance audit is unavailable or expired. Run a new audit.',
  );
type Audit = {
  owner: string;
  params: PerformanceParams;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  promise?: Promise<ContentResult>;
  result?: ContentResult;
  error?: unknown;
};

// ponytail: process-local, like prepared views; use shared storage before non-sticky routing.
export class PerformanceAudits {
  private audits = new Map<string, Audit>();

  prepare(params: PerformanceParams, owner: string): string {
    if (Buffer.byteLength(JSON.stringify(params)) > 64 * 1024)
      throw new UserError(
        'Performance audit input exceeds the inline size limit.',
      );
    let owned = [...this.audits.values()].filter(
      (audit) => audit.owner === owner,
    ).length;
    for (const [ref, audit] of this.audits) {
      if (this.audits.size < 64 && owned < 16) break;
      if (!audit.result && audit.error === undefined) continue;
      if (owned >= 16 && audit.owner !== owner) continue;
      clearTimeout(audit.timer);
      this.audits.delete(ref);
      if (audit.owner === owner) owned--;
    }
    if (this.audits.size >= 64 || owned >= 16)
      throw new UserError(
        'Too many retained performance audits. Try again after older audits expire.',
      );
    const ref = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(unavailable());
      this.audits.delete(ref);
    }, PERFORMANCE_AUDIT_TTL_MS);
    timer.unref();
    this.audits.set(ref, {
      owner,
      params: structuredClone(params),
      controller,
      timer,
    });
    return ref;
  }

  private require(ref: string, owner: string): Audit {
    const audit = this.audits.get(ref);
    if (!audit || audit.owner !== owner) throw unavailable();
    return audit;
  }

  run(
    ref: string,
    owner: string,
    signal: AbortSignal | undefined,
    execute: (
      params: PerformanceParams,
      signal: AbortSignal,
    ) => Promise<ContentResult>,
  ): Promise<ContentResult> {
    const audit = this.require(ref, owner);
    signal?.throwIfAborted();
    audit.promise ??= Promise.resolve()
      .then(async () => {
        audit.controller.signal.throwIfAborted();
        const result = await execute(audit.params, audit.controller.signal);
        audit.controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          throw new UserError(
            'Performance report exceeds the inline size limit. Try fewer audit categories.',
          );
        audit.result = result;
        return result;
      })
      .catch((error: unknown) => {
        audit.error = error ?? new UserError('The performance audit failed.');
        throw audit.error;
      });
    const abort = () => audit.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    return audit.promise.finally(() =>
      signal?.removeEventListener('abort', abort),
    );
  }

  read(ref: string, owner: string): ContentResult | undefined {
    const audit = this.require(ref, owner);
    if (audit.error !== undefined) throw audit.error;
    return audit.result;
  }
}
