import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge';

const client = new Client(
  { name: 'Local widget probe host', version: '0.1.0' },
  {
    capabilities: {
      extensions: {
        'io.modelcontextprotocol/ui': {
          mimeTypes: ['text/html;profile=mcp-app'],
        },
      },
    },
  },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('/mcp', location.href), {
    requestInit: { headers: { Authorization: 'Bearer local-alice' } },
  }),
);
let bridge;
window.probe = {
  client,
  mounts: 0,
  chunkAttempts: 0,
  chunkFailures: 0,
  failChunkAt: 0,
  forceIdentityChunks: false,
  prepare: (name, args = {}) => client.callTool({ name, arguments: args }),
  async show(viewRef) {
    const result = await client.callTool({
      name: 'browserless_show',
      arguments: { viewRef },
    });
    if (result.isError) throw new Error(result.content[0].text);
    if (bridge) await bridge.teardownResource({});
    const iframe = document.createElement('iframe');
    iframe.id = 'widget';
    iframe.title = 'Shared result viewer';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    document.querySelector('#mount').replaceChildren(iframe);
    this.mounts++;
    bridge = new AppBridge(
      client,
      { name: 'Local widget probe host', version: '0.1.0' },
      { serverTools: {}, logging: {} },
    );
    bridge.oninitialized = async () => {
      await bridge.sendToolInput({ arguments: { viewRef } });
      await bridge.sendToolResult(result);
    };
    await bridge.connect(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
    );
    // Install after connect, which sets up the SDK's default forwarding handlers.
    bridge.oncalltool = async (params) => {
      if (params.name === 'browserless_view_data') {
        if (this.forceIdentityChunks)
          params = {
            ...params,
            arguments: { ...params.arguments, encoding: 'identity' },
          };
        this.chunkAttempts++;
        if (this.chunkAttempts === this.failChunkAt) {
          this.chunkFailures++;
          throw new McpError(
            -32000,
            'Synthetic UNAVAILABLE: Connection failed.',
          );
        }
      }
      return client.callTool(params);
    };
    iframe.src = '/probe/widget';
  },
};
for (const button of document.querySelectorAll('button[data-tool]'))
  button.onclick = async () => {
    try {
      const prepared = await window.probe.prepare(
        button.dataset.tool,
        button.dataset.large ? { large: true } : {},
      );
      await window.probe.show(prepared.structuredContent.viewRef);
      document.querySelector('#host-status').textContent =
        'Prepared and shown through two MCP calls.';
    } catch (reason) {
      document.querySelector('#host-status').textContent = reason.message;
    }
  };
window.ready = true;
