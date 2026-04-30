import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import {
  MAX_TEXT_RESPONSE_CHARS,
  formatFunctionContent,
  registerFunctionTool,
} from '../../src/tools/function.js';
import type { GenericApiResult } from '../../src/tools/schemas.js';
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
  oauthEnabled: false,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
};

describe('browserless_function tool', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    mockContext.reportProgress.resetHistory();
  });

  afterEach(() => {
    sinon.restore();
  });

  function getToolExecute(server: FastMCP) {
    const addToolSpy = sinon.spy(server, 'addTool');
    registerFunctionTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerFunctionTool(server, mockConfig)).to.not.throw();
  });

  it('returns JSON text on successful function execution', async () => {
    const responseData = JSON.stringify({ books: [{ title: 'A Light in the Attic' }] });
    fetchStub.resolves(
      new Response(responseData, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        code: 'export default async ({ page }) => { return { data: {}, type: "application/json" }; }',
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.type).to.equal('text');
    expect(mainContent.text).to.include('books');

    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('Content-Type: application/json');
    expect(metadata.text).to.include('Status: 200');
  });

  it('sends code and context in the request body', async () => {
    fetchStub.resolves(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        code: 'export default async ({ page, context }) => ({ data: context, type: "application/json" })',
        context: { pageNumber: 2 },
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/function');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.code).to.include('context');
    expect(body.context).to.deep.equal({ pageNumber: 2 });
  });

  it('throws UserError on non-2xx response', async () => {
    fetchStub.resolves(
      new Response('Bad Request: code is required', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { code: '' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('400');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerFunctionTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute(
        { code: 'export default async () => ({})' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('returns a PDF response as a resource block, not inline base64', async () => {
    const pdfBuffer = Buffer.from('fake-pdf-content');
    fetchStub.resolves(
      new Response(pdfBuffer, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { code: 'export default async ({ page }) => page.pdf()' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const metadata = content[0] as Extract<Content, { type: 'text' }>;
    expect(metadata.text).to.include('Content-Type: application/pdf');
    // Crucially, the base64 must NOT be inlined as text — that was the old
    // bug that torched context.
    expect(metadata.text).to.not.include(pdfBuffer.toString('base64'));

    const resource = content[1] as Extract<Content, { type: 'resource' }>;
    expect(resource.type).to.equal('resource');
    expect(resource.resource.mimeType).to.equal('application/pdf');
    expect(resource.resource.blob).to.equal(pdfBuffer.toString('base64'));
    expect(resource.resource.uri).to.match(/\.pdf$/);
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { code: 'export default async () => ({})' },
      mockContext,
    );

    expect(mockContext.reportProgress.calledTwice).to.be.true;
    expect(mockContext.reportProgress.firstCall.args[0]).to.deep.equal({
      progress: 0,
      total: 100,
    });
    expect(mockContext.reportProgress.secondCall.args[0]).to.deep.equal({
      progress: 100,
      total: 100,
    });
  });
});

describe('formatFunctionContent', () => {
  const FAKE_BASE64 = 'Zm9vYmFy';

  const makeResponse = (
    overrides: Partial<GenericApiResult> = {},
  ): GenericApiResult => ({
    data: 'hello',
    contentType: 'text/plain',
    contentDisposition: null,
    statusCode: 200,
    ok: true,
    size: 5,
    isBinary: false,
    ...overrides,
  });

  it('promotes image/png to an image content block', () => {
    const content = formatFunctionContent(
      makeResponse({
        contentType: 'image/png',
        isBinary: true,
        data: FAKE_BASE64,
      }),
    );
    const image = content[1] as Extract<Content, { type: 'image' }>;
    expect(image.type).to.equal('image');
    expect(image.mimeType).to.equal('image/png');
    expect(image.data).to.equal(FAKE_BASE64);
  });

  it('promotes image/jpeg, normalizing charset parameters', () => {
    const content = formatFunctionContent(
      makeResponse({
        contentType: 'image/jpeg; charset=binary',
        isBinary: true,
        data: FAKE_BASE64,
      }),
    );
    const image = content[1] as Extract<Content, { type: 'image' }>;
    expect(image.mimeType).to.equal('image/jpeg');
  });

  it('promotes audio/mpeg to an audio content block', () => {
    const content = formatFunctionContent(
      makeResponse({
        contentType: 'audio/mpeg',
        isBinary: true,
        data: FAKE_BASE64,
      }),
    );
    const audio = content[1] as Extract<Content, { type: 'audio' }>;
    expect(audio.type).to.equal('audio');
    expect(audio.mimeType).to.equal('audio/mpeg');
  });

  it('emits a resource block for non-image/audio binaries', () => {
    const content = formatFunctionContent(
      makeResponse({
        contentType: 'application/zip',
        isBinary: true,
        data: FAKE_BASE64,
      }),
    );
    const resource = content[1] as Extract<Content, { type: 'resource' }>;
    expect(resource.type).to.equal('resource');
    expect(resource.resource.uri).to.match(/\.zip$/);
    expect(resource.resource.blob).to.equal(FAKE_BASE64);
  });

  it('throws UserError when text payload exceeds the cap', () => {
    const huge = 'a'.repeat(MAX_TEXT_RESPONSE_CHARS + 1);
    expect(() =>
      formatFunctionContent(makeResponse({ data: huge, size: huge.length })),
    ).to.throw(UserError, /exceeding the .* limit/);
  });

  it('error message points to image/audio types as the fix', () => {
    const huge = 'a'.repeat(MAX_TEXT_RESPONSE_CHARS + 1);
    try {
      formatFunctionContent(makeResponse({ data: huge, size: huge.length }));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.match(/image\/jpeg|image\/png/);
      expect((err as Error).message).to.include('application/pdf');
    }
  });

  it('passes text payloads under the cap through normally', () => {
    const content = formatFunctionContent(
      makeResponse({
        data: '{"books":[]}',
        contentType: 'application/json',
        size: 12,
      }),
    );
    const main = content[0] as Extract<Content, { type: 'text' }>;
    expect(main.text).to.equal('{"books":[]}');
    const meta = content[1] as Extract<Content, { type: 'text' }>;
    expect(meta.text).to.include('Content-Type: application/json');
  });
});
