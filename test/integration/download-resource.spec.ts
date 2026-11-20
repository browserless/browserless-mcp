import { expect } from 'chai';
import sinon from 'sinon';
import { rm } from 'node:fs/promises';
import { registerDownloadResource } from '../../src/resources/download-resource.js';
import { artifactServer } from '../helpers/artifact-server.js';
import {
  clearSession,
  downloadOwner,
  storeDownload,
} from '../../src/lib/download-store.js';

describe('authenticated artifact resources', () => {
  let f: Awaited<ReturnType<typeof artifactServer>>;
  beforeEach(async () => {
    f = await artifactServer();
  });
  afterEach(async () => {
    await f.close();
  });

  it('reads exact PDF/JSON blobs with canonical filenames and preserves upload handles', async () => {
    const { client } = await f.connect();
    for (const [filename, mimeType, bytes] of [
      [
        'résumé 50%.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.7\nfixture\u0000\u00ff'),
      ],
      [
        'report.json',
        'application/json',
        Buffer.from('{"private":"do not inline"}'),
      ],
      ['empty.zip', 'application/zip', Buffer.alloc(0)],
    ] as const) {
      const rec = await storeDownload(
        filename,
        mimeType,
        bytes,
        downloadOwner('fixture-owner'),
      );
      const uri = `browserless-download://${rec.id}/${encodeURIComponent(filename)}`;
      for (const wrong of [
        'wrong-name.pdf',
        '%2Fetc%2Fpasswd',
        '%ZZ',
        `${encodeURIComponent(filename)}%2525`,
      ]) {
        let malformed: unknown;
        try {
          await client.readResource({
            uri: `browserless-download://${rec.id}/${wrong}`,
          });
        } catch (error) {
          malformed = error;
        }
        expect(malformed, wrong).to.be.instanceOf(Error);
      }
      const result = await client.readResource({ uri });
      expect(result.contents).to.have.length(1);
      expect(result.contents[0]).to.include({ uri, mimeType });
      expect(result.contents[0]).not.to.have.property('text');
      expect(
        Buffer.from((result.contents[0] as { blob: string }).blob, 'base64'),
      ).to.deep.equal(bytes);
      expect(JSON.stringify(result)).not.to.include(rec.path);
      let repeated: unknown;
      try {
        await client.readResource({ uri });
      } catch (error) {
        repeated = error;
      }
      expect(repeated).to.be.instanceOf(Error);
    }
  });

  it('denies foreign, missing and swapped authentication without burning the artifact', async () => {
    const a = await f.connect(),
      b = await f.connect('fixture-foreign');
    const rec = await storeDownload(
      'private.pdf',
      'application/pdf',
      Buffer.from('private'),
      downloadOwner('fixture-owner'),
    );
    const uri = `browserless-download://${rec.id}/private.pdf`;
    const errors: string[] = [];
    for (const readUri of [
      uri,
      `browserless-download://${'0'.repeat(32)}/private.pdf`,
    ]) {
      try {
        await b.client.readResource({ uri: readUri });
      } catch (error) {
        errors.push(String(error));
      }
    }
    expect(errors).to.have.length(2);
    expect(errors[0]).to.equal(errors[1]);
    for (const token of [undefined, 'fixture-foreign']) {
      const response = await fetch(`${f.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': a.transport.sessionId!,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/read',
          params: { uri },
        }),
      });
      expect(response.status).to.equal(token ? 404 : 401);
      expect(await response.text()).not.to.include('private');
    }
    const result = await a.client.readResource({ uri });
    expect(
      Buffer.from(
        (result.contents[0] as { blob: string }).blob,
        'base64',
      ).toString(),
    ).to.equal('private');
  });

  it('never falls back to the server token when loader authentication is absent', async () => {
    const capture = sinon.stub(f.server, 'addResourceTemplate');
    registerDownloadResource(f.server, f.config);
    const template = capture.firstCall.args[0];
    capture.restore();
    const token = f.config.browserlessToken!;
    const rec = await storeDownload(
      'server.pdf',
      'application/pdf',
      Buffer.from('private'),
      downloadOwner(token),
    );
    let error: unknown;
    try {
      await template.load({ id: rec.id, filename: rec.filename });
    } catch (cause) {
      error = cause;
    }
    expect(error).to.be.instanceOf(Error);
    const result = await template.load(
      { id: rec.id, filename: rec.filename },
      { token, apiUrl: f.config.browserlessApiUrl },
    );
    expect(result).to.have.property(
      'blob',
      Buffer.from('private').toString('base64'),
    );
  });

  it('retains native delivery when subsequent headers are omitted and rejects switching', async () => {
    const a = await f.connect(),
      legacy = await f.connect('fixture-legacy', false);
    delete a.headers['x-browserless-artifact-delivery'];
    f.reply('image/png', Buffer.from('private-native-image'));
    const args = {
      name: 'browserless_function',
      arguments: { code: 'export default () => ({})' },
    };
    const native = await a.client.callTool(args);
    expect(JSON.stringify(native)).to.include('delivery: mcp-resource');
    expect(JSON.stringify(native)).not.to.include(
      Buffer.from('private-native-image').toString('base64'),
    );
    const old = await legacy.client.callTool(args);
    expect(old.content).to.deep.include({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('private-native-image').toString('base64'),
    });
    const switched = await fetch(`${f.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...legacy.headers,
        'x-browserless-artifact-delivery': 'mcp-resource',
        'mcp-session-id': legacy.transport.sessionId!,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: args,
      }),
    });
    expect(switched.status).to.equal(400);
    expect(await switched.text()).to.include('fixed for this session');
  });

  it('retains consumed binary responses only for the authenticated opening session', async () => {
    const a = await f.connect(),
      other = await f.connect(),
      foreign = await f.connect('fixture-foreign');
    const bytes = Buffer.from('%PDF-private-retained-artifact\u0000\u00ff');
    const rec = await storeDownload(
      'retained.pdf',
      'application/pdf',
      bytes,
      downloadOwner('fixture-owner'),
      a.transport.sessionId,
    );
    const uri = `browserless-download://${rec.id}/retained.pdf`;
    const headers = {
      ...a.headers,
      'mcp-session-id': a.transport.sessionId!,
      'mcp-protocol-version': '2025-11-25',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const response = await fetch(`${f.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 91,
        method: 'resources/read',
        params: { uri },
      }),
    });
    expect(response.status).to.equal(200);
    const original = await response.text();
    const cursor = original.match(/^id: (.+)$/m)![1].trim();
    const blob = bytes.toString('base64');
    expect(original).to.include(blob);
    let repeated: unknown;
    try {
      await a.client.readResource({ uri });
    } catch (error) {
      repeated = error;
    }
    expect(repeated).to.be.instanceOf(Error);
    for (const [sessionId, token, status] of [
      [a.transport.sessionId!, undefined, 401],
      [a.transport.sessionId!, 'fixture-foreign', 404],
      [other.transport.sessionId!, 'fixture-owner', 400],
      [foreign.transport.sessionId!, 'fixture-foreign', 400],
    ] as const) {
      const denied = await fetch(`${f.baseUrl}/mcp`, {
        headers: {
          ...headers,
          Authorization: token ? `Bearer ${token}` : '',
          'mcp-session-id': sessionId,
          'Last-Event-ID': cursor,
        },
      });
      expect(denied.status).to.equal(status);
      expect(await denied.text()).not.to.include(blob);
    }
    const replay = await fetch(`${f.baseUrl}/mcp`, {
      headers: { ...headers, 'Last-Event-ID': cursor },
      signal: AbortSignal.timeout(3000),
    });
    expect(replay.status).to.equal(200);
    const reader = replay.body!.getReader();
    let retained = '';
    try {
      while (!retained.includes(blob)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        retained += new TextDecoder().decode(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    expect(retained).to.include(blob);
    const ended = await fetch(`${f.baseUrl}/mcp`, {
      method: 'DELETE',
      headers,
    });
    expect(ended.status).to.equal(200);
    const afterEnd = await fetch(`${f.baseUrl}/mcp`, {
      headers: { ...headers, 'Last-Event-ID': cursor },
    });
    expect(afterEnd.status).to.equal(404);
    expect(await afterEnd.text()).not.to.include(blob);
  });

  it('atomically consumes the same file across HTTP and MCP', async () => {
    const { client } = await f.connect();
    for (const order of ['http-first', 'mcp-first', 'race']) {
      const rec = await storeDownload(
        'race.pdf',
        'application/pdf',
        Buffer.from('race winner'),
        downloadOwner('fixture-owner'),
      );
      const http = async () => {
        const response = await fetch(`${f.baseUrl}/download/${rec.id}`, {
          headers: { Authorization: 'Bearer fixture-owner' },
        });
        const body = await response.text();
        if (response.ok) expect(body).to.equal('race winner');
        return response.ok;
      };
      const mcp = async () => {
        let result;
        try {
          result = await client.readResource({
            uri: `browserless-download://${rec.id}/race.pdf`,
          });
        } catch {
          return false;
        }
        expect(
          Buffer.from(
            (result.contents[0] as { blob: string }).blob,
            'base64',
          ).toString(),
        ).to.equal('race winner');
        return true;
      };
      const outcomes =
        order === 'race'
          ? await Promise.all([http(), mcp()])
          : order === 'http-first'
            ? [await http(), await mcp()]
            : [await mcp(), await http()];
      expect(outcomes.filter(Boolean), order).to.have.length(1);
    }
  });

  it('keeps cleanup and missing-file failures consumed without exposing server paths', async () => {
    const { client, transport } = await f.connect();
    for (const reason of ['cleanup', 'missing']) {
      const rec = await storeDownload(
        'gone.pdf',
        'application/pdf',
        Buffer.from('gone'),
        downloadOwner('fixture-owner'),
        transport.sessionId,
      );
      if (reason === 'cleanup') clearSession(transport.sessionId);
      else await rm(rec.path);
      for (let i = 0; i < 2; i++) {
        let error: unknown;
        try {
          await client.readResource({
            uri: `browserless-download://${rec.id}/gone.pdf`,
          });
        } catch (cause) {
          error = cause;
        }
        expect(error).to.be.instanceOf(Error);
        expect(String(error)).not.to.include(rec.path);
        expect(String(error)).not.to.include('ENOENT');
      }
    }
  });

  it('lists only a generic template, never live artifacts', async () => {
    const { client } = await f.connect();
    const rec = await storeDownload(
      'never-list-me.pdf',
      'application/pdf',
      Buffer.from('hidden'),
      downloadOwner('fixture-owner'),
    );
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate)).to.include(
      'browserless-download://{id}/{filename}',
    );
    const resources = await client.listResources();
    expect(JSON.stringify({ resources, templates })).not.to.include(rec.id);
    expect(JSON.stringify({ resources, templates })).not.to.include(
      rec.filename,
    );
  });

  it('refuses native files over the verified limit without consuming HTTP access', async () => {
    const { client } = await f.connect();
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0x73);
    const rec = await storeDownload(
      'large.bin',
      'application/octet-stream',
      bytes,
      downloadOwner('fixture-owner'),
    );
    let error: unknown;
    try {
      await client.readResource({
        uri: `browserless-download://${rec.id}/large.bin`,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).to.be.instanceOf(Error);
    expect(String(error)).to.include('native transfer limit');
    const response = await fetch(`${f.baseUrl}/download/${rec.id}`, {
      headers: { Authorization: 'Bearer fixture-owner' },
    });
    expect(response.status).to.equal(200);
    expect(Buffer.from(await response.arrayBuffer())).to.deep.equal(bytes);
  });

  it('keeps binary resource templates off the restricted connector surface', async () => {
    await f.close();
    f = await artifactServer(true);
    const { client } = await f.connect();
    const result = await client.listResourceTemplates();
    expect(result.resourceTemplates.map((r) => r.uriTemplate)).not.to.include(
      'browserless-download://{id}/{filename}',
    );
  });

  it('saves native binary tool outputs and explicit JSON saves without inline payloads', async () => {
    const { client } = await f.connect();
    for (const [name, args, mimeType, data] of [
      [
        'browserless_export',
        { url: 'https://example.com/export' },
        'application/zip',
        Buffer.from('PK\u0000private-export'),
      ],
      [
        'browserless_function',
        { code: 'export default () => ({})' },
        'image/png',
        Buffer.from('private-png'),
      ],
      [
        'browserless_export',
        { url: 'https://example.com/export-json', toDisk: true },
        'application/json',
        Buffer.from('{"private":"export-json"}'),
      ],
      [
        'browserless_export',
        { url: 'https://example.com/export-text', toDisk: true },
        'text/plain',
        Buffer.from('private-export-text'),
      ],
      [
        'browserless_function',
        { code: 'export default () => ({})', toDisk: true },
        'application/json',
        Buffer.from('{"private":"saved-json"}'),
      ],
      [
        'browserless_function',
        { code: 'export default () => ({})', toDisk: true },
        'text/plain',
        Buffer.from('private-large-text'.repeat(15000)),
      ],
    ] as const) {
      f.reply(mimeType, data);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.to.equal(true);
      const json = JSON.stringify(result);
      expect(json).not.to.include(data.toString('base64'));
      expect(json).not.to.include(data.toString());
      const uri = json.match(
        /resourceUri: (browserless-download:\/\/[^\\\s"]+)/,
      )?.[1];
      expect(uri, json).to.be.a('string');
      const read = await client.readResource({ uri: uri! });
      expect(
        Buffer.from((read.contents[0] as { blob: string }).blob, 'base64'),
      ).to.deep.equal(data);
      expect(f.requests.at(-1)!.body).not.to.have.property('toDisk');
    }
  });

  it('preserves legacy defaults and explicit inline image analysis', async () => {
    const a = await f.connect(),
      legacy = await f.connect('fixture-legacy', false);
    f.reply('image/png', Buffer.from('intentional-analysis'));
    for (const [client, args] of [
      [a.client, { toDisk: false }],
      [legacy.client, {}],
    ] as const) {
      const result = await client.callTool({
        name: 'browserless_function',
        arguments: { code: 'export default () => ({})', ...args },
      });
      expect(result.isError).not.to.equal(true);
      expect(result.content).to.deep.include({
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('intentional-analysis').toString('base64'),
      });
    }
  });

  it('saves smart-scraper attachments freshly on cache hits and keeps requested text', async () => {
    const a = await f.connect(),
      b = await f.connect('fixture-other');
    const bytes = Buffer.from('private-cached-screenshot');
    f.reply(
      'application/json',
      Buffer.from(
        JSON.stringify({
          ok: true,
          statusCode: 200,
          content: '<p>requested text</p>',
          contentType: 'text/html',
          headers: {},
          strategy: 'browser',
          attempted: ['browser'],
          message: null,
          screenshot: bytes.toString('base64'),
          pdf: Buffer.from('private-cached-pdf').toString('base64'),
          markdown: 'requested text',
          links: null,
        }),
      ),
    );
    const uris: string[] = [];
    for (const client of [a.client, a.client, b.client]) {
      const result = await client.callTool({
        name: 'browserless_smartscraper',
        arguments: {
          url: 'https://example.com/cached',
          formats: ['markdown', 'screenshot'],
        },
      });
      const json = JSON.stringify(result);
      expect(result.isError, json).not.to.equal(true);
      expect(json).to.include('requested text');
      expect(json).not.to.include(bytes.toString('base64'));
      expect(json).not.to.include(
        Buffer.from('private-cached-pdf').toString('base64'),
      );
      const uri = json.match(
        /resourceUri: (browserless-download:\/\/[0-9a-f]{32}\/screenshot\.png)/,
      )?.[1];
      expect(uri, json).to.be.a('string');
      uris.push(uri!);
    }
    expect(new Set(uris).size).to.equal(3);
    expect(
      f.requests.filter((r) => r.path.startsWith('/smart-scrape')),
    ).to.have.length(2);
    let foreign: unknown;
    try {
      await b.client.readResource({ uri: uris[0] });
    } catch (error) {
      foreign = error;
    }
    expect(foreign).to.be.instanceOf(Error);
    expect(
      Buffer.from(
        (
          (await a.client.readResource({ uri: uris[0] })).contents[0] as {
            blob: string;
          }
        ).blob,
        'base64',
      ),
    ).to.deep.equal(bytes);
    const inline = await a.client.callTool({
      name: 'browserless_smartscraper',
      arguments: {
        url: 'https://example.com/cached',
        formats: ['markdown', 'screenshot'],
        toDisk: false,
      },
    });
    expect(inline.content).to.deep.include({
      type: 'image',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
    });
    expect(inline.content).to.deep.include({
      type: 'resource',
      resource: {
        uri: 'browserless://smartscraper/document.pdf',
        mimeType: 'application/pdf',
        blob: Buffer.from('private-cached-pdf').toString('base64'),
      },
    });
  });
});
