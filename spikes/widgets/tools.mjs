// Local feasibility probe. Synthetic data and credentials only; not production storage.
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { UserError, jsonSchemaAdapter } from 'fastmcp';
import { getConfig } from '../../build/src/config.js';
import { defineTool } from '../../build/src/lib/define-tool.js';

export const URI = 'ui://browserless/view/v3.html';
export const INLINE_LIMIT = 2 * 1024 * 1024;
export const CHUNK_LIMIT = 128 * 1024;
const PAGE_CHARS = 96 * 1024;
const UNAVAILABLE =
  'This view is unavailable. Run the original data tool again to prepare a new view.';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/replay-widget.json', import.meta.url),
    'utf8',
  ),
);

export function registerProbeTools(
  server,
  { now = Date.now, ttlMs = 900000 } = {},
) {
  const views = new Map();
  const stats = {
    replay: 0,
    sessions: 0,
    usage: 0,
    performance: 0,
    show: 0,
    chunks: 0,
  };
  const config = {
    ...getConfig(),
    transport: 'httpStream',
    complianceMode: false,
    analyticsEnabled: false,
    browserlessToken: undefined,
    browserlessApiUrl: 'http://127.0.0.1:9',
  };
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const descriptions = {
    widget_probe_replay:
      'Prepare a synthetic replay and return a viewRef without rendering. Call browserless_show with that exact viewRef to display it. Set large:true to exercise widget-driven chunk loading; omit paddingBytes for normal tests.',
    widget_probe_sessions:
      'Read a synthetic sessions snapshot, numbered on each refresh. Returns a viewRef without rendering; use browserless_show to display it. The rendered view has a Refresh button.',
    widget_probe_usage:
      'Read synthetic usage for hour, day, or week. Returns a viewRef without rendering; use browserless_show to display it. The rendered view has a timeframe selector.',
    widget_probe_performance:
      'Prepare a synthetic performance scorecard with a null accessibility score. Returns a viewRef without rendering; use browserless_show to display it.',
    browserless_show:
      'Render a previously prepared synthetic result inline. Pass the exact viewRef returned by a widget_probe_* tool. Does not rerun the producer. Only this tool renders a widget.',
    browserless_view_data:
      'Widget-only reader for bounded chunks of a prepared result. Use the exact viewRef and returned cursor. Does not render a new widget.',
  };
  const define = (name, parameters, run, meta) =>
    defineTool(server, config, undefined, {
      name,
      description: descriptions[name],
      outputSchema:
        name === 'browserless_view_data'
          ? z.object({
              complete: z.boolean(),
              nextCursor: z.string().optional(),
            })
          : jsonSchemaAdapter({
              type: 'object',
              ...z.toJSONSchema(
                z.discriminatedUnion(
                  'kind',
                  ['replay', 'active-sessions', 'usage', 'performance'].map(
                    (kind) =>
                      z.object({
                        kind: z.literal(kind),
                        summary: z.string(),
                        viewRef: z.string(),
                        expiresAt: z.string().optional(),
                        data: z.unknown().optional(),
                      }),
                  ),
                ),
                { target: 'draft-7' },
              ),
            }),
      parameters,
      annotations,
      ...(meta ? { _meta: meta } : {}),
      run,
      format: (result) => result,
    });
  const purge = () => {
    for (const [id, view] of views) if (view.expires <= now()) views.delete(id);
  };
  const get = (id, owner) => {
    purge();
    const view = views.get(id);
    if (!view || view.owner !== owner) throw new UserError(UNAVAILABLE);
    return view;
  };
  const prepare = (kind, payload, summary, owner) => {
    purge();
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json);
    if (bytes > 50 * 1024 * 1024)
      throw new UserError('Synthetic view exceeds the local storage limit.');
    // ponytail: bounded, process-local demo store; shared storage is a separate release gate.
    while (
      views.size >= 12 ||
      [...views.values()].reduce((sum, view) => sum + view.bytes, 0) + bytes >
        50 * 1024 * 1024
    ) {
      views.delete(views.keys().next().value);
    }
    const viewRef = `view_${randomUUID()}`;
    const encoded = Buffer.from(json).toString('base64');
    views.set(viewRef, {
      owner,
      kind,
      payload,
      summary,
      bytes,
      encoded,
      expires: now() + ttlMs,
      cursors: Array.from(
        { length: Math.ceil(encoded.length / PAGE_CHARS) },
        () => randomUUID(),
      ),
    });
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        kind,
        viewRef,
        expiresAt: new Date(now() + ttlMs).toISOString(),
        summary,
        ...(kind !== 'replay' ? { data: payload } : {}),
      },
    };
  };

  define(
    'widget_probe_replay',
    z.object({
      large: z.boolean().optional(),
      paddingBytes: z
        .number()
        .int()
        .min(0)
        .max(3 * 1024 * 1024)
        .default(0),
    }),
    async ({ params, token }) => {
      stats.replay++;
      return prepare(
        'replay',
        {
          ...fixture,
          padding: params.large
            ? 'PRIVATE-REPLAY-🚀'.repeat(180000)
            : 'x'.repeat(params.paddingBytes),
        },
        'Prepared synthetic replay.',
        token,
      );
    },
  );
  define('widget_probe_sessions', z.object({}), async ({ token }) => {
    const revision = ++stats.sessions;
    return prepare(
      'active-sessions',
      {
        revision,
        sessions: [
          {
            id: 'synthetic-browser',
            browser: 'Chromium',
            status: `Refresh ${revision}`,
          },
        ],
      },
      `Sessions snapshot ${revision}`,
      token,
    );
  });
  define(
    'widget_probe_usage',
    z.object({ timeframe: z.enum(['hour', 'day', 'week']).default('day') }),
    async ({ params, token }) => {
      stats.usage++;
      return prepare(
        'usage',
        {
          timeframe: params.timeframe,
          used: { hour: 10, day: 240, week: 1680 }[params.timeframe],
          included: 2000,
        },
        `Usage for ${params.timeframe}`,
        token,
      );
    },
  );
  define('widget_probe_performance', z.object({}), async ({ token }) => {
    stats.performance++;
    return prepare(
      'performance',
      {
        scores: { performance: 92, accessibility: null, seo: 78 },
        metrics: { LCP: '1.8 s', CLS: '0.02', TBT: '120 ms' },
      },
      'Prepared synthetic scorecard.',
      token,
    );
  });
  define(
    'browserless_show',
    z.object({ viewRef: z.string().max(128) }),
    async ({ params, token }) => {
      const view = get(params.viewRef, token);
      stats.show++;
      const result = {
        content: [{ type: 'text', text: view.summary }],
        structuredContent: {
          kind: view.kind,
          viewRef: params.viewRef,
          summary: view.summary,
        },
        _meta: { payload: view.payload },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > INLINE_LIMIT)
        result._meta = {
          source: {
            viewRef: params.viewRef,
            encoding: 'base64-json',
            bytes: view.bytes,
          },
        };
      return result;
    },
    { ui: { resourceUri: URI }, 'openai/outputTemplate': URI },
  );
  define(
    'browserless_view_data',
    z.object({
      viewRef: z.string().max(128),
      cursor: z.string().max(128).optional(),
      encoding: z.enum(['identity', 'gzip']).default('identity'),
    }),
    async ({ params, token }) => {
      const view = get(params.viewRef, token);
      if (params.encoding === 'gzip' && !view.gzip) {
        const encoded = gzipSync(
          Buffer.from(JSON.stringify(view.payload)),
        ).toString('base64');
        view.gzip = {
          encoded,
          cursors: Array.from(
            { length: Math.ceil(encoded.length / PAGE_CHARS) },
            () => randomUUID(),
          ),
        };
      }
      const data = params.encoding === 'gzip' ? view.gzip : view;
      const page = params.cursor ? data.cursors.indexOf(params.cursor) : 0;
      if (page < 0) throw new UserError(UNAVAILABLE);
      stats.chunks++;
      const nextCursor = data.cursors[page + 1];
      return {
        content: [],
        structuredContent: {
          ...(nextCursor ? { nextCursor } : {}),
          complete: !nextCursor,
        },
        _meta: {
          encoding:
            params.encoding === 'gzip' ? 'base64-gzip-json' : 'base64-json',
          totalChars: data.encoded.length,
          data: data.encoded.slice(page * PAGE_CHARS, (page + 1) * PAGE_CHARS),
        },
      };
    },
    { ui: { visibility: ['app'] } },
  );

  // Keep the old URI readable while a refreshed descriptor selects the new loader.
  for (const uri of [
    URI,
    'ui://browserless/view/v2.html',
    'ui://browserless/view/v1.html',
  ])
    server.addResource({
      uri,
      name: `Local widget probe ${uri.split('/').at(-1)}`,
      mimeType: 'text/html;profile=mcp-app',
      async load() {
        return {
          text: readFileSync(new URL('./widget.html', import.meta.url), 'utf8'),
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        };
      },
    });
  return { stats, views };
}
