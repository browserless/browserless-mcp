import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerAgentTools } from '../../src/tools/agent.js';
import { registerShowTools } from '../../src/tools/show.js';
import { registerViewWidget } from '../../src/resources/view-widget.js';
import { registerMediaPreviewRoute } from '../../src/resources/media-preview.js';
import { replayViews } from '../../src/lib/view-store.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';
import { clearSession } from '../../src/lib/download-store.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmhsAAAAASUVORK5CYII=';
const webm = Buffer.concat([
  Buffer.from([26, 69, 223, 163]),
  Buffer.from('webm transport fixture'),
]);

describe('real agent tool media integration over MCP', () => {
  it('uses actual command results, preserves vision/fallback output, and shows media without repeating commands', async () => {
    const commands: string[] = [];
    const backend = await makeRespondingServer((method) => {
      commands.push(method);
      if (method === 'screenshot') return { base64: png };
      if (method === 'stopRecording') return { value: webm.toString('base64') };
      return { recording: true };
    });
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const config = {
      ...getConfig(),
      browserlessToken: undefined,
      browserlessApiUrl: backend.url,
      transport: 'httpStream' as const,
      mcpBaseUrl: base,
      complianceMode: false,
      analyticsEnabled: false,
      maxRetries: 0,
    };
    const server = new FastMCP({
      name: 'Agent media integration',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'upstream-secret',
        apiUrl: backend.url,
        authMethod: 'oauth',
        accountId: 'shared',
        userId: request.headers.authorization?.slice(7) ?? 'alice',
      }),
    });
    registerAgentTools(server, config);
    registerShowTools(server, config);
    registerViewWidget(server, config);
    registerMediaPreviewRoute(server);
    const clients: Client[] = [];
    async function connect(user: string, ui = true) {
      const client = new Client(
        { name: 'Media test', version: '1.0.0' },
        {
          capabilities: ui
            ? {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
                  },
                },
              }
            : {},
        },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + user } },
        }),
      );
      return client;
    }
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { host: '127.0.0.1', port },
      });
      const alice = await connect('alice');
      const listed = (await alice.listTools()).tools;
      assert.equal(
        listed.find((t) => t.name === 'browserless_agent')!.outputSchema,
        undefined,
      );
      assert.equal(
        listed.find((t) => t.name === 'browserless_agent')!._meta,
        undefined,
      );
      const prepared = await alice.callTool({
        name: 'browserless_agent',
        arguments: {
          commands: [
            { method: 'screenshot', params: {} },
            { method: 'screenshot', params: {} },
          ],
        },
      });
      assert.ok(!prepared.isError, JSON.stringify(prepared.content));
      assert.equal(prepared.structuredContent, undefined);
      assert.ok(
        (prepared.content as any[]).some(
          (block) => block.type === 'image' && block.data === png,
        ),
      );
      const reference = JSON.stringify(prepared.content).match(
        /view_[0-9a-f-]+/,
      )?.[0];
      assert.ok(reference);
      const executed = commands.length;
      const shown = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: reference },
      });
      assert.ok(!shown.isError, JSON.stringify(shown.content));
      assert.equal(
        ShowOutputSchema.parse(shown.structuredContent).kind,
        'agent-media',
      );
      const assets = (shown._meta!.payload as any).artifacts;
      assert.equal(assets.length, 2);
      assert.equal(commands.length, executed);
      const bytes = await fetch(assets[0].previewUrl);
      assert.deepEqual(
        Buffer.from(await bytes.arrayBuffer()),
        Buffer.from(png, 'base64'),
      );
      const largeBatch = await alice.callTool({
        name: 'browserless_agent',
        arguments: {
          commands: Array.from({ length: 13 }, () => ({
            method: 'screenshot',
            params: {},
          })),
        },
      });
      assert.ok(!largeBatch.isError, JSON.stringify(largeBatch.content));
      const largeRef = JSON.stringify(largeBatch.content).match(
        /view_[0-9a-f-]+/,
      )?.[0];
      assert.ok(
        largeRef,
        'large screenshot batches still return a widget reference',
      );
      const largeView = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: largeRef },
      });
      assert.ok(!largeView.isError, JSON.stringify(largeView.content));
      assert.equal((largeView._meta!.payload as any).artifacts.length, 12);
      assert.match(
        (largeView.structuredContent as any).summary,
        /first 12 of 13/,
      );
      const bob = await connect('bob');
      assert.equal(
        (
          await bob.callTool({
            name: 'browserless_show',
            arguments: { viewRef: reference },
          })
        ).isError,
        true,
      );
      const noUi = await connect('alice', false);
      const fallback = await noUi.callTool({
        name: 'browserless_agent',
        arguments: { commands: [{ method: 'screenshot', params: {} }] },
      });
      assert.ok(!fallback.isError);
      assert.equal(fallback.structuredContent, undefined);
      assert.equal(
        /view_[0-9a-f-]+/.test(JSON.stringify(fallback.content)),
        false,
      );
      assert.ok(
        (fallback.content as any[]).some((block) => block.type === 'image'),
      );
      const recording = await alice.callTool({
        name: 'browserless_agent',
        arguments: {
          record: true,
          commands: [
            { method: 'startRecording', params: {} },
            { method: 'scroll', params: { direction: 'down' } },
            { method: 'stopRecording', params: {} },
          ],
        },
      });
      assert.ok(!recording.isError, JSON.stringify(recording.content));
      assert.equal(
        JSON.stringify(recording.content).includes('upstream-secret'),
        false,
      );
      const videoRef = JSON.stringify(recording.content).match(
        /view_[0-9a-f-]+/,
      )?.[0];
      assert.ok(videoRef);
      const video = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: videoRef },
      });
      assert.ok(!video.isError, JSON.stringify(video.content));
      const asset = (video._meta!.payload as any).artifacts[0];
      assert.equal(asset.mimeType, 'video/webm');
      const part = await fetch(asset.previewUrl, {
        headers: { Range: 'bytes=0-3' },
      });
      assert.equal(part.status, 206);
      assert.deepEqual(
        Buffer.from(await part.arrayBuffer()),
        webm.subarray(0, 4),
      );
      const reconnect = await connect('alice');
      assert.ok(
        !(
          await reconnect.callTool({
            name: 'browserless_show',
            arguments: { viewRef: videoRef },
          })
        ).isError,
      );
    } finally {
      for (const session of server.sessions) clearSession(session.sessionId);
      await Promise.allSettled(clients.map((c) => c.close()));
      await server.stop();
      await backend.close();
      await replayViews.clear();
    }
  });
});
