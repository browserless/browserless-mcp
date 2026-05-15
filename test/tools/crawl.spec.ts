import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerCrawlTool } from '../../src/tools/crawl.js';
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

describe('browserless_crawl tool', () => {
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
    registerCrawlTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerCrawlTool(server, mockConfig)).to.not.throw();
  });

  it('starts a crawl and waits for completion', async () => {
    // First call: POST /crawl to start
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-123',
          url: 'https://api.example.com/crawl/crawl-123',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // Second call: GET /crawl/{id} - in progress
    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'in-progress',
          total: 3,
          completed: 1,
          failed: 0,
          expiresAt: null,
          next: null,
          data: [
            {
              status: 'completed',
              contentUrl: 'https://storage.example.com/content/1',
              metadata: {
                title: 'Home Page',
                description: 'Welcome to our site',
                language: 'en',
                scrapedAt: '2024-01-01T00:00:00Z',
                sourceURL: 'https://example.com/',
                statusCode: 200,
                error: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // Third call: GET /crawl/{id} - completed
    fetchStub.onCall(2).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 3,
          completed: 3,
          failed: 0,
          expiresAt: '2024-01-08T00:00:00Z',
          next: null,
          data: [
            {
              status: 'completed',
              contentUrl: 'https://storage.example.com/content/1',
              metadata: {
                title: 'Home Page',
                description: 'Welcome to our site',
                language: 'en',
                scrapedAt: '2024-01-01T00:00:00Z',
                sourceURL: 'https://example.com/',
                statusCode: 200,
                error: null,
              },
            },
            {
              status: 'completed',
              contentUrl: 'https://storage.example.com/content/2',
              metadata: {
                title: 'About Page',
                description: 'About us',
                language: 'en',
                scrapedAt: '2024-01-01T00:00:01Z',
                sourceURL: 'https://example.com/about',
                statusCode: 200,
                error: null,
              },
            },
            {
              status: 'completed',
              contentUrl: 'https://storage.example.com/content/3',
              metadata: {
                title: 'Contact Page',
                description: 'Contact us',
                language: 'en',
                scrapedAt: '2024-01-01T00:00:02Z',
                sourceURL: 'https://example.com/contact',
                statusCode: 200,
                error: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com', pollInterval: 10 },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(3);

    const summaryContent = content[0] as { type: string; text: string };
    expect(summaryContent.text).to.include('Crawl Results');
    expect(summaryContent.text).to.include('completed');
    expect(summaryContent.text).to.include('Total Pages:** 3');
  });

  it('returns crawl ID immediately when waitForCompletion is false', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-456',
          url: 'https://api.example.com/crawl/crawl-456',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com', waitForCompletion: false },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.equal(1);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Crawl Started');
    expect(mainContent.text).to.include('crawl-456');
    expect(mainContent.text).to.include('running asynchronously');

    // Should only have called fetch once (to start the crawl)
    expect(fetchStub.calledOnce).to.be.true;
  });

  it('sends correct request to POST /crawl endpoint', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-789',
          url: 'https://api.example.com/crawl/crawl-789',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        limit: 50,
        maxDepth: 3,
        allowSubdomains: true,
        sitemap: 'force',
        includePaths: ['/blog/*'],
        excludePaths: ['/admin/*'],
        scrapeOptions: {
          formats: ['markdown', 'html'],
          onlyMainContent: true,
        },
        waitForCompletion: false,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/crawl');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.url).to.equal('https://example.com');
    expect(body.limit).to.equal(50);
    expect(body.maxDepth).to.equal(3);
    expect(body.allowSubdomains).to.be.true;
    expect(body.sitemap).to.equal('force');
    expect(body.includePaths).to.deep.equal(['/blog/*']);
    expect(body.excludePaths).to.deep.equal(['/admin/*']);
    expect(body.scrapeOptions.formats).to.deep.equal(['markdown', 'html']);
  });

  it('handles failed pages in results', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-fail',
          url: 'https://api.example.com/crawl/crawl-fail',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 2,
          completed: 1,
          failed: 1,
          expiresAt: null,
          next: null,
          data: [
            {
              status: 'completed',
              contentUrl: 'https://storage.example.com/content/1',
              metadata: {
                title: 'Home Page',
                description: null,
                language: 'en',
                scrapedAt: '2024-01-01T00:00:00Z',
                sourceURL: 'https://example.com/',
                statusCode: 200,
                error: null,
              },
            },
            {
              status: 'failed',
              contentUrl: null,
              metadata: {
                title: null,
                description: null,
                language: null,
                scrapedAt: null,
                sourceURL: 'https://example.com/broken',
                statusCode: 404,
                error: 'Page not found',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com', pollInterval: 10 },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;

    // Find the failed pages section
    const failedSection = content.find(
      (c: Content) =>
        c.type === 'text' &&
        (c as { text: string }).text.includes('Failed Pages'),
    ) as { type: string; text: string } | undefined;

    expect(failedSection).to.exist;
    expect(failedSection!.text).to.include('Failed Pages (1)');
    expect(failedSection!.text).to.include('broken');
    expect(failedSection!.text).to.include('Page not found');
  });

  it('throws UserError when crawl fails to start', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Maximum concurrent crawls reached',
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute({ url: 'https://example.com' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Failed to start crawl');
    }
  });

  it('throws UserError for non-http protocol', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute({ url: 'ftp://example.com' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('ftp:');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerCrawlTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute({ url: 'https://example.com' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('throws UserError when crawl status is failed', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-failed',
          url: 'https://api.example.com/crawl/crawl-failed',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'failed',
          total: 5,
          completed: 2,
          failed: 3,
          expiresAt: null,
          next: null,
          data: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'https://example.com', pollInterval: 10 },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Crawl failed');
      expect((err as Error).message).to.include('crawl-failed');
    }
  });

  it('reports progress during execution', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-progress',
          url: 'https://api.example.com/crawl/crawl-progress',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 2,
          completed: 2,
          failed: 0,
          expiresAt: null,
          next: null,
          data: [
            {
              status: 'completed',
              contentUrl: null,
              metadata: {
                title: 'Page 1',
                description: null,
                language: null,
                scrapedAt: null,
                sourceURL: 'https://example.com/1',
                statusCode: 200,
                error: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com', pollInterval: 10 },
      mockContext,
    );

    // Should have at least initial and final progress reports
    expect(mockContext.reportProgress.callCount).to.be.at.least(2);
    expect(mockContext.reportProgress.firstCall.args[0]).to.deep.equal({
      progress: 0,
      total: 100,
    });
    expect(mockContext.reportProgress.lastCall.args[0]).to.deep.equal({
      progress: 100,
      total: 100,
    });
  });

  it('throws error when getCrawl returns 401 unauthorized', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-auth',
          url: 'https://api.example.com/crawl/crawl-auth',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // GET /crawl/{id} returns 401
    fetchStub.onCall(1).resolves(
      new Response('Invalid API token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'https://example.com', pollInterval: 10 },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      // API client throws regular Error for non-OK responses
      expect(err).to.be.instanceOf(Error);
      expect((err as Error).message).to.include('401');
      expect((err as Error).message).to.include('Invalid API token');
    }
  });

  it('always waits between polls even when total/completed is 0', async () => {
    const pollInterval = 50; // Short interval for test
    let pollCount = 0;
    const pollTimes: number[] = [];

    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-zero',
          url: 'https://api.example.com/crawl/crawl-zero',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // Return 0/0 for first few polls, then complete
    fetchStub.onCall(1).callsFake(() => {
      pollTimes.push(Date.now());
      pollCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'in-progress',
            total: 0,
            completed: 0,
            failed: 0,
            expiresAt: null,
            next: null,
            data: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    });

    fetchStub.onCall(2).callsFake(() => {
      pollTimes.push(Date.now());
      pollCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'completed',
            total: 1,
            completed: 1,
            failed: 0,
            expiresAt: null,
            next: null,
            data: [
              {
                status: 'completed',
                contentUrl: null,
                metadata: {
                  title: 'Page',
                  description: null,
                  language: null,
                  scrapedAt: null,
                  sourceURL: 'https://example.com/',
                  statusCode: 200,
                  error: null,
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    });

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ url: 'https://example.com', pollInterval }, mockContext);

    // Should have polled twice (one in-progress, one completed)
    expect(pollCount).to.equal(2);

    // Time between polls should be at least pollInterval
    if (pollTimes.length >= 2) {
      const timeBetweenPolls = pollTimes[1] - pollTimes[0];
      expect(timeBetweenPolls).to.be.at.least(pollInterval - 10); // Allow 10ms tolerance
    }
  });

  it('handles pagination when fetching all pages', async () => {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-paginated',
          url: 'https://api.example.com/crawl/crawl-paginated',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // First status call - returns partial data with next URL
    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 3,
          completed: 3,
          failed: 0,
          expiresAt: null,
          next: 'https://api.example.com/crawl/crawl-paginated?skip=2',
          data: [
            {
              status: 'completed',
              contentUrl: null,
              metadata: {
                title: 'Page 1',
                description: null,
                language: null,
                scrapedAt: null,
                sourceURL: 'https://example.com/1',
                statusCode: 200,
                error: null,
              },
            },
            {
              status: 'completed',
              contentUrl: null,
              metadata: {
                title: 'Page 2',
                description: null,
                language: null,
                scrapedAt: null,
                sourceURL: 'https://example.com/2',
                statusCode: 200,
                error: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    // Second status call with skip=2
    fetchStub.onCall(2).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 3,
          completed: 3,
          failed: 0,
          expiresAt: null,
          next: null,
          data: [
            {
              status: 'completed',
              contentUrl: null,
              metadata: {
                title: 'Page 3',
                description: null,
                language: null,
                scrapedAt: null,
                sourceURL: 'https://example.com/3',
                statusCode: 200,
                error: null,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com', pollInterval: 10 },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;

    // Find the URL list section to verify all pages are included
    const urlListSection = content.find(
      (c: Content) =>
        c.type === 'text' &&
        (c as { text: string }).text.includes('Crawled URLs'),
    ) as { type: string; text: string } | undefined;

    expect(urlListSection).to.exist;
    expect(urlListSection!.text).to.include('https://example.com/1');
    expect(urlListSection!.text).to.include('https://example.com/2');
    expect(urlListSection!.text).to.include('https://example.com/3');

    // Should have called fetch 3 times (start + 2 status calls)
    expect(fetchStub.callCount).to.equal(3);
  });

  it('does not include profile in the outbound /crawl URL when omitted', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-no-profile',
          url: 'https://api.example.com/crawl/crawl-no-profile',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com', waitForCompletion: false },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.not.include('profile=');
  });

  it('forwards profile as a query parameter to /crawl', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-with-profile',
          url: 'https://api.example.com/crawl/crawl-with-profile',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        profile: 'my-login',
        waitForCompletion: false,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('/crawl');
    expect(url).to.include('token=test-token');
    expect(url).to.include('profile=my-login');
  });

  it('URL-encodes the profile name', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-encoded',
          url: 'https://api.example.com/crawl/crawl-encoded',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        profile: 'profile with spaces',
        waitForCompletion: false,
      },
      mockContext,
    );

    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('profile=profile+with+spaces');
  });

  it('throws UserError (not a property-access crash) when the profile does not exist', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({ error: 'Profile "missing-crawl" was not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        {
          url: 'https://example.com',
          profile: 'missing-crawl',
          waitForCompletion: false,
        },
        mockContext,
      );
      expect.fail('expected UserError');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Profile "missing-crawl"');
      expect((err as Error).message).to.not.include('Cannot read properties');
    }
  });

  it('caps URL list at MAX_URL_LIST (200) to avoid huge responses', async () => {
    // Generate 250 pages to exceed the 200 cap
    const pages = Array.from({ length: 250 }, (_, i) => ({
      status: 'completed',
      contentUrl: null,
      metadata: {
        title: `Page ${i + 1}`,
        description: null,
        language: null,
        scrapedAt: null,
        sourceURL: `https://example.com/page-${i + 1}`,
        statusCode: 200,
        error: null,
      },
    }));

    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          success: true,
          id: 'crawl-large',
          url: 'https://api.example.com/crawl/crawl-large',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    fetchStub.onCall(1).resolves(
      new Response(
        JSON.stringify({
          status: 'completed',
          total: 250,
          completed: 250,
          failed: 0,
          expiresAt: null,
          next: null,
          data: pages,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com', pollInterval: 10 },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;

    // Find the URL list section
    const urlListSection = content.find(
      (c: Content) =>
        c.type === 'text' &&
        (c as { text: string }).text.includes('Crawled URLs'),
    ) as { type: string; text: string } | undefined;

    expect(urlListSection).to.exist;
    // Should show truncation message
    expect(urlListSection!.text).to.include('and 50 more URLs');
    // Should have page-200 but not page-201
    expect(urlListSection!.text).to.include('page-200');
    expect(urlListSection!.text).to.not.include('page-201');
  });
});
