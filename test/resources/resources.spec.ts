import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { registerApiDocsResource } from '../../src/resources/api-docs.js';
import { registerStatusResource } from '../../src/resources/status.js';
import type { McpConfig } from '../../src/config.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  sqsRegion: 'us-east-1',
};

describe('Resources', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('api-docs resource', () => {
    it('registers without error', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      expect(() =>
        registerApiDocsResource(server, mockConfig),
      ).to.not.throw();
    });

    it('load returns markdown with API URL', async () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addResourceSpy = sinon.spy(server, 'addResource');
      registerApiDocsResource(server, mockConfig);

      const resource = addResourceSpy.firstCall.args[0];
      const result = await resource.load();

      const text = (result as { text: string }).text;
      expect(text).to.include('# Browserless Smart Scraper API');
      expect(text).to.include('https://api.example.com');
      expect(text).to.include('url');
      expect(text).to.include('screenshot');
      expect(text).to.include('markdown');
    });

    it('can be registered alongside other resources', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      registerApiDocsResource(server, mockConfig);
      server.addResource({
        uri: 'test://other',
        name: 'Other',
        async load() {
          return { text: 'other' };
        },
      });
    });
  });

  describe('status resource', () => {
    it('registers without error', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      expect(() =>
        registerStatusResource(server, mockConfig),
      ).to.not.throw();
    });

    it('load returns ok when API is reachable', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('[]', { status: 200 }));

      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addResourceSpy = sinon.spy(server, 'addResource');
      registerStatusResource(server, mockConfig);

      const resource = addResourceSpy.firstCall.args[0];
      const result = await resource.load();

      const parsed = JSON.parse((result as { text: string }).text);
      expect(parsed.ok).to.be.true;
      expect(parsed.apiUrl).to.equal('https://api.example.com');
      expect(parsed.timestamp).to.be.a('string');
    });

    it('load returns not ok when API is unreachable', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.rejects(new Error('ECONNREFUSED'));

      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addResourceSpy = sinon.spy(server, 'addResource');
      registerStatusResource(server, mockConfig);

      const resource = addResourceSpy.firstCall.args[0];
      const result = await resource.load();

      const parsed = JSON.parse((result as { text: string }).text);
      expect(parsed.ok).to.be.false;
      expect(parsed.message).to.include('ECONNREFUSED');
    });
  });
});
