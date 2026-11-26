import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import {
  formatCoverageLines,
  MapParamsSchema,
  registerMapTool,
} from '../../src/tools/map.js';
import type {
  MapCoverage,
  MapParams,
  McpConfig,
} from '../../src/@types/types.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  oauthRegisterRateLimitPerHour: 300,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  signal: new AbortController().signal,
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
  elicit: sinon.stub().resolves({ action: 'cancel' }),
};

describe('formatCoverageLines', () => {
  const url = 'https://example.com';
  const defaults = MapParamsSchema.parse({ url });
  const cases: {
    name: string;
    coverage: MapCoverage;
    params: Partial<MapParams>;
    count?: number;
    expected: [number, string][];
  }[] = [
    {
      name: 'distinguishes skipped sitemaps from empty sitemaps',
      coverage: { sitemapUrls: null, pagesScanned: [url], timedOut: false },
      params: { sitemap: 'skip' },
      expected: [[0, 'Sitemap: not checked (sitemap mode "skip")']],
    },
    {
      name: 'does not imply the sitemap was missing when searching',
      coverage: { sitemapUrls: 0, pagesScanned: [url], timedOut: false },
      params: { search: 'pricing' },
      expected: [[0, 'Sitemap: no sitemap URLs matched the search']],
    },
    {
      name: 'explains when sitemap results fill the limit',
      coverage: { sitemapUrls: 20, pagesScanned: [], timedOut: false },
      params: { limit: 20 },
      count: 20,
      expected: [
        [0, "Sitemap: 20 URLs from the site's sitemap"],
        [1, 'Page links: not read (the sitemap filled the limit of 20)'],
        [2, 'Coverage: partial. Stopped at the limit of 20 URLs.'],
      ],
    },
    {
      name: 'attributes the lack of page links to sitemap-only mode',
      coverage: { sitemapUrls: 5, pagesScanned: [], timedOut: false },
      params: { sitemap: 'only' },
      expected: [[1, 'Page links: not read (sitemap mode "only")']],
    },
    {
      name: 'reports a timed-out collection that did not read the start page',
      coverage: { sitemapUrls: 5, pagesScanned: [], timedOut: true },
      params: { limit: 50 },
      count: 5,
      expected: [
        [1, 'Page links: not read (the start page could not be read in time)'],
        [
          2,
          'Coverage: partial. The request timed out before mapping finished.',
        ],
      ],
    },
    {
      name: 'lists every reported page when there are several',
      coverage: {
        sitemapUrls: 0,
        pagesScanned: [url, `${url}/other`],
        timedOut: false,
      },
      params: {},
      expected: [
        [
          1,
          `Links read from 2 pages: ${url}, ${url}/other. Linked pages were not visited.`,
        ],
      ],
    },
    {
      name: 'gives the timeout precedence over the limit',
      coverage: { sitemapUrls: 3, pagesScanned: [url], timedOut: true },
      params: { limit: 3 },
      count: 3,
      expected: [
        [
          2,
          'Coverage: partial. The request timed out before mapping finished.',
        ],
      ],
    },
  ];

  for (const { name, coverage, params, count, expected } of cases) {
    it(name, () => {
      const links =
        count === undefined
          ? undefined
          : Array.from({ length: count }, (_, i) => ({ url: `${url}/${i}` }));
      const lines = formatCoverageLines(
        { success: true, links, coverage },
        { ...defaults, ...params },
      );
      for (const [index, line] of expected) expect(lines[index]).to.equal(line);
    });
  }
});

describe('browserless_map tool', () => {
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
    registerMapTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('describes the sources and limits of mapping on the full surface', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const spy = sinon.spy(server, 'addTool');
    registerMapTool(server, mockConfig);
    expect(spy.firstCall.args[0].description).to.equal(
      "List the URLs of a website using Browserless. Reads the site's sitemap and the links on the start page only; linked pages are not visited, so the result is often a partial list of the site. Returns URLs with optional titles and descriptions, followed by a coverage summary that says how many URLs came from the sitemap and which page's links were read. Use the search parameter to order results by relevance to a query. Useful for site audits and content discovery.",
    );
  });

  it('connector rejects a limit above 500 before making a backend request', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const spy = sinon.spy(server, 'addTool');
    registerMapTool(server, { ...mockConfig, complianceMode: true });
    const error = await spy.firstCall.args[0]
      .execute({ url: 'https://example.com', limit: 501 }, mockContext)
      .catch((e) => e);
    expect(error).to.be.instanceOf(UserError);
    expect((error as Error).message).to.equal(
      'limit can be at most 500 on this endpoint.',
    );
    expect(fetchStub.called).to.equal(false);
  });

  it('returns discovered URLs', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          links: [
            { url: 'https://example.com/', title: 'Home' },
            { url: 'https://example.com/about', title: 'About Us' },
            { url: 'https://example.com/contact', title: 'Contact' },
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

    const result = await execute({ url: 'https://example.com' }, mockContext);

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Site Map Results');
    expect(mainContent.text).to.include('3 URLs');
    expect(mainContent.text).to.include('https://example.com/');
    expect(mainContent.text).to.include('https://example.com/about');
    expect(content.at(-1)).to.deep.include({
      text: [
        '---',
        'Base URL: https://example.com',
        'URLs Found: 3',
        'Sitemap Mode: include',
        'Coverage: may be partial. Only the sitemap and the links on the start page are read; linked pages are not visited.',
        '---',
      ].join('\n'),
    });
  });

  it('prints coverage after the existing footer lines on both surfaces', async () => {
    const url = 'https://quotes.toscrape.com';
    for (const complianceMode of [false, true]) {
      fetchStub.resolves(
        Response.json({
          success: true,
          links: Array.from({ length: 47 }, (_, i) => ({
            url: `${url}/tag/${i}`,
          })),
          coverage: { sitemapUrls: 0, pagesScanned: [url], timedOut: false },
        }),
      );
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const spy = sinon.spy(server, 'addTool');
      registerMapTool(server, { ...mockConfig, complianceMode });
      const result = await spy.firstCall.args[0].execute({ url }, mockContext);
      const footer = (result as { content: Content[] }).content.at(-1);
      expect(footer?.type).to.equal('text');
      if (footer?.type === 'text') {
        expect(footer.text).to.have.string(
          [
            '---',
            `Base URL: ${url}`,
            'URLs Found: 47',
            'Sitemap Mode: include',
            'Sitemap: no URLs found (the site has no sitemap, or it could not be read)',
            `Links read from 1 page: ${url}. Linked pages were not visited.`,
            'Coverage: may be partial. Pages that are neither in the sitemap nor linked from the start page are not listed.',
            '---',
          ].join('\n'),
        );
      }
    }
  });

  it('sends correct request to /map endpoint', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          links: [],
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
        search: 'products',
        limit: 50,
        sitemap: 'only',
        includeSubdomains: false,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/map');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.url).to.equal('https://example.com');
    expect(body.search).to.equal('products');
    expect(body.limit).to.equal(50);
    expect(body.sitemap).to.equal('only');
    expect(body.includeSubdomains).to.be.false;
  });

  it('includes URL list in output', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          links: [
            { url: 'https://example.com/page1' },
            { url: 'https://example.com/page2' },
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

    const result = await execute({ url: 'https://example.com' }, mockContext);

    const content = (result as { content: Content[] }).content;
    const urlListBlock = content.find(
      (c: Content) =>
        c.type === 'text' &&
        (c as { text: string }).text.includes('## URL List'),
    ) as { type: string; text: string } | undefined;

    expect(urlListBlock).to.exist;
    expect(urlListBlock!.text).to.include('https://example.com/page1');
    expect(urlListBlock!.text).to.include('https://example.com/page2');
  });

  it('throws UserError when map fails', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Unable to access site',
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
      await execute({ url: 'https://example.com' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Map failed');
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
    registerMapTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute({ url: 'https://example.com' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('handles empty results', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          links: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute({ url: 'https://example.com' }, mockContext);

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('No URLs found');
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          links: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ url: 'https://example.com' }, mockContext);

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
