import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { createServer } from 'node:net';
import https from 'node:https';
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { registerStageFileTool } from '../../src/tools/stage-file.js';
import { normalizeUploadCommand } from '../../src/tools/agent.js';
import {
  clearSession,
  consumeDownload,
  downloadOwner,
  getDownload,
} from '../../src/lib/download-store.js';

describe('browserless_stage_file', () => {
  const config = {
    ...getConfig(),
    browserlessToken: 'stage-test-token',
    transport: 'httpStream' as const,
    complianceMode: false,
    analyticsEnabled: false,
  };
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });

  afterEach(() => sinon.restore());

  it('registers only on full HTTP, never compliant or stdio', () => {
    for (const transport of ['httpStream', 'stdio'] as const) {
      for (const complianceMode of [false, true]) {
        const server = new FastMCP({ name: 'test', version: '1.0.0' });
        const add = sinon.spy(server, 'addTool');
        registerSurface(server, { ...config, transport, complianceMode });
        expect(
          add.args.some(([tool]) => tool.name === 'browserless_stage_file'),
        ).to.equal(transport === 'httpStream' && !complianceMode);
      }
    }
  });

  for (const file_name of [undefined, '../../folder\\report.csv', '..']) {
    it(`stages safely with optional filename ${file_name}, reusable across transports and sessions until TTL`, async () => {
      const server = new FastMCP({ name: 'test', version: '1.0.0' });
      const downloader = sinon.stub().resolves(Buffer.from('abc'));
      const add = sinon.spy(server, 'addTool');
      registerStageFileTool(server, config, undefined, downloader);
      const tool = add.firstCall.args[0];
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      });
      const result = await tool.execute(
        {
          file: {
            download_url: 'https://example.com/file',
            file_id: 'file-1',
            ...(file_name ? { file_name, mime_type: 'text/csv' } : {}),
          },
        },
        {
          reportProgress: async () => {},
          session: undefined,
          sessionId: 'transport-one',
          log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as Parameters<typeof tool.execute>[1],
      );
      const value = JSON.parse(
        (result as { content: { text: string }[] }).content[0].text,
      );
      expect(value).to.have.keys('handle', 'filename', 'mimeType', 'size');
      expect(value.filename).to.equal(
        file_name?.includes('report') ? 'report.csv' : 'upload',
      );
      expect(value.mimeType).to.equal(
        file_name ? 'text/csv' : 'application/octet-stream',
      );
      expect(value.size).to.equal(3);
      const owner = downloadOwner(config.browserlessToken!);
      const record = getDownload(value.handle, owner)!;
      expect(record.sessionId).to.equal(undefined);
      expect(
        getDownload(value.handle, downloadOwner('another-token')),
      ).to.equal(undefined);
      clearSession('transport-one');
      try {
        for (const transport of ['httpStream', 'stdio'] as const) {
          const file: Record<string, unknown> = { handle: value.handle };
          await normalizeUploadCommand(
            { method: 'uploadFile', params: { files: [file] } },
            transport,
            undefined,
            config.browserlessToken!,
          );
          expect(file.content).to.equal('YWJj');
          expect(file.mimeType).to.equal(value.mimeType);
          expect(getDownload(value.handle, owner)).to.exist;
        }
        clock.tick(15 * 60 * 1000);
        expect(getDownload(value.handle, owner)).to.equal(undefined);
      } finally {
        clock.restore();
        consumeDownload(value.handle, owner);
        await rm(record.path, { force: true });
      }
    });
  }

  it('publishes native metadata and exact required pair over real HTTP; rejects missing fields and disabled downloads', async () => {
    const server = new FastMCP({ name: 'test', version: '1.0.0' });
    registerSurface(server, config);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const port = await freePort();
    try {
      await server.start({ transportType: 'httpStream', httpStream: { port } });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${port}/mcp`),
        ),
      );
      const tool = (await client.listTools()).tools.find(
        (tool) => tool.name === 'browserless_stage_file',
      );
      expect(tool).to.exist;
      expect(tool!._meta).to.deep.equal({ 'openai/fileParams': ['file'] });
      expect(tool!.inputSchema.required).to.deep.equal(['file']);
      const file = tool!.inputSchema.properties!.file as {
        required: string[];
        properties: object;
      };
      expect(file.required).to.deep.equal(['download_url', 'file_id']);
      expect(file.properties).to.have.keys(
        'download_url',
        'file_id',
        'mime_type',
        'file_name',
      );
      const fetchFile = sinon.spy(https, 'request');
      for (const file of [
        { download_url: 'https://example.com/file' },
        { file_id: 'file-1' },
      ]) {
        const error = await client
          .callTool({ name: tool!.name, arguments: { file } })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.match(/required|Invalid input/i);
        expect(fetchFile.called).to.equal(false);
      }
      const result = await client.callTool({
        name: tool!.name,
        arguments: {
          file: { download_url: 'https://example.com/file', file_id: 'file-1' },
        },
      });
      expect(result.isError).to.equal(true);
      expect(JSON.stringify(result)).to.include(
        'Native file download disabled',
      );
      expect(JSON.stringify(result)).not.to.include('browserless-download://');
      expect(fetchFile.called).to.equal(false);
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
