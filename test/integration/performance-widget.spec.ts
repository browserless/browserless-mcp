import { expect } from 'chai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { clearSession } from '../../src/lib/download-store.js';
import {
  PERFORMANCE_URI,
  PerformanceViewSchema,
} from '../../src/lib/performance-summary.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/lighthouse-performance.json', 'utf8'),
);
const capabilities = {
  extensions: {
    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  },
};

describe('performance scorecard over real MCP HTTP', () => {
  for (const compliant of [false, true]) {
    it(`renders one audit on the ${compliant ? 'compliant' : 'full'} surface and preserves legacy output`, async () => {
      let calls = 0;
      const backend = createServer(async (request, response) => {
        calls++;
        let body = '';
        for await (const chunk of request) body += chunk;
        expect(JSON.parse(body).url).to.equal('https://example.test/');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ type: 'json', data: fixture }));
      });
      await new Promise<void>((resolve) =>
        backend.listen(0, '127.0.0.1', resolve),
      );
      const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
      const reserve = createServer();
      await new Promise<void>((resolve) =>
        reserve.listen(0, '127.0.0.1', resolve),
      );
      const port = (reserve.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reserve.close(() => resolve()));
      const server = new FastMCP({
        name: 'scorecard-test',
        version: '1.0.0',
        authenticate: async () => ({ token: 'synthetic-token', apiUrl: base }),
      });
      registerSurface(server, {
        ...getConfig(),
        browserlessApiUrl: base,
        transport: 'httpStream',
        complianceMode: compliant,
        analyticsEnabled: false,
        maxRetries: 0,
      });
      const clients: Client[] = [];
      const connect = async (ui: boolean) => {
        const client = new Client(
          { name: 'scorecard-host', version: '1.0.0' },
          { capabilities: ui ? capabilities : {} },
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/mcp`),
          ),
        );
        return client;
      };
      try {
        await server.start({
          transportType: 'httpStream',
          httpStream: { host: '127.0.0.1', port },
        });
        const ui = await connect(true);
        const tools = (await ui.listTools()).tools;
        expect(
          tools.find((tool) => tool.name === 'browserless_performance')!._meta,
        ).to.deep.include({
          ui: { resourceUri: PERFORMANCE_URI },
          'openai/outputTemplate': PERFORMANCE_URI,
        });
        if (compliant) expect(tools).to.have.length(5);
        const resource = (await ui.readResource({ uri: PERFORMANCE_URI }))
          .contents[0];
        expect(resource.mimeType).to.equal('text/html;profile=mcp-app');
        expect(resource._meta!.ui).to.deep.include({
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
        });
        expect('text' in resource && resource.text).to.include(
          'Performance report',
        );
        const args = { url: 'https://example.test/', categories: ['seo'] };
        const visual = await ui.callTool({
          name: 'browserless_performance',
          arguments: args,
        });
        expect(visual.isError).not.to.equal(true);
        const summary = PerformanceViewSchema.parse(visual.structuredContent);
        expect(summary.categories.map((category) => category.id)).to.deep.equal(
          ['seo'],
        );
        expect(summary.metrics).to.deep.equal([]);
        expect(calls).to.equal(1);
        const legacy = await connect(false);
        const plain = await legacy.callTool({
          name: 'browserless_performance',
          arguments: args,
        });
        expect(plain.isError).not.to.equal(true);
        expect(plain).not.to.have.property('structuredContent');
        expect(calls).to.equal(2);
        const legacyText = plain.content as Array<{ text: string }>;
        const visualText = visual.content as Array<{ text: string }>;
        if (compliant) {
          expect(visual.content).to.deep.equal(plain.content);
          expect(JSON.stringify(visual)).not.to.match(
            /synthetic-token|download|token=|Lighthouse Version/,
          );
        } else {
          // Download handles differ; scores, metrics, and footer must not.
          expect(visualText[0]).to.deep.equal(legacyText[0]);
          expect(visualText[1]).to.deep.equal(legacyText[1]);
          expect(visualText.at(-1)).to.deep.equal(legacyText.at(-1));
        }
      } finally {
        for (const session of server.sessions) clearSession(session.sessionId);
        await Promise.allSettled(clients.map((client) => client.close()));
        await server.stop();
        backend.closeAllConnections();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
      }
    });
  }
});
