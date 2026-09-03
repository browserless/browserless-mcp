import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';

import { registerAccountTool } from '../../src/tools/account.js';
import { registerUsageTool } from '../../src/tools/usage.js';
import { registerSessionsTool } from '../../src/tools/sessions.js';
import { registerLogsTool } from '../../src/tools/logs.js';
import { replayBrowser } from '../../src/lib/session-replay-artifact.js';
import type { McpConfig } from '../../src/@types/types.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://runtime.example.com',
  apiServerUrl: 'https://account.example.com',
  replayCdnUrl: 'https://replay.example.com/',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
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
  elicit: sinon.stub().resolves({ action: 'cancel' }),
};

const gql = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const textOf = (result: unknown) =>
  ((result as { content: Content[] }).content[0] as { text: string }).text;

const executeFor = (
  register: (s: FastMCP, c: McpConfig) => void,
): ((args: unknown, ctx: unknown) => Promise<unknown>) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  register(server, mockConfig);
  return addToolSpy.firstCall.args[0].execute as never;
};

const requestBody = (stub: sinon.SinonStub) =>
  JSON.parse(stub.firstCall.args[1].body as string);

describe('account-data tools', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    // The local path opens a real browser otherwise.
    sinon.stub(replayBrowser, 'open').returns(true);
  });

  afterEach(() => sinon.restore());

  describe('browserless_account', () => {
    const summary = {
      accountSummary: {
        plan: 'oneHundredEightyThousand',
        planType: 'cloud-unit-based',
        isNewPricing: true,
        pastDue: false,
        currentPeriodEnd: 1702592000,
        cloudUnits: {
          unitsLeft: 178766,
          used: 1234,
          available: 180000,
          overageFee: 0.0015,
          name: 'oneHundredEightyThousand',
        },
        apiKeys: [
          {
            apiKeyId: 'key_1',
            name: 'primary',
            createdAt: 1700000000000,
            revoked: false,
          },
        ],
        extensions: [],
      },
    };

    it('hits the account API, not the browser runtime', async () => {
      fetchStub.resolves(gql(summary));

      await executeFor(registerAccountTool)({ action: 'billing' }, mockContext);

      expect(fetchStub.firstCall.args[0]).to.equal(
        'https://account.example.com/graphql',
      );
      expect(requestBody(fetchStub).variables.apiToken).to.equal('test-token');
    });

    it('reports the plan and unit balance for action billing', async () => {
      fetchStub.resolves(gql(summary));

      const text = textOf(
        await executeFor(registerAccountTool)(
          { action: 'billing' },
          mockContext,
        ),
      );

      expect(text).to.include('oneHundredEightyThousand');
      expect(text).to.include('178766');
      expect(text).to.include('1234');
    });

    it('lists keys by name for action keys, with no token material', async () => {
      fetchStub.resolves(gql(summary));

      const text = textOf(
        await executeFor(registerAccountTool)({ action: 'keys' }, mockContext),
      );

      expect(text).to.include('API keys (1)');
      expect(text).to.include('primary');
      expect(text).to.include('key_1');
      expect(text).to.not.include('test-token');
    });

    it('states payment status even when the account is current', async () => {
      fetchStub.resolves(gql(summary));

      const text = textOf(
        await executeFor(registerAccountTool)(
          { action: 'billing' },
          mockContext,
        ),
      );

      expect(text).to.include('Payment status: current');
    });

    it('flags a past-due account', async () => {
      fetchStub.resolves(
        gql({ accountSummary: { ...summary.accountSummary, pastDue: true } }),
      );

      const text = textOf(
        await executeFor(registerAccountTool)(
          { action: 'billing' },
          mockContext,
        ),
      );

      expect(text).to.include('past due');
    });

    it('says so plainly when the plan has no unit balance', async () => {
      fetchStub.resolves(
        gql({
          accountSummary: { ...summary.accountSummary, cloudUnits: null },
        }),
      );

      const text = textOf(
        await executeFor(registerAccountTool)(
          { action: 'billing' },
          mockContext,
        ),
      );

      expect(text).to.include('not on a unit-based plan');
    });
  });

  describe('browserless_usage', () => {
    const ledger = {
      planType: 'cloud-unit-based',
      currentPeriodEnd: 1787171268,
      cloudUnits: { unitsLeft: 0, used: 19, available: 1000, overageFee: 0 },
    };

    it('sends timeframe as a non-null variable with a day default', async () => {
      fetchStub.resolves(
        gql({ accountUsage: { summary: null }, accountSummary: ledger }),
      );

      await executeFor(registerUsageTool)({}, mockContext);

      const body = requestBody(fetchStub);
      expect(body.query).to.include('$timeframe: timeframe!');
      expect(body.variables.timeframe).to.equal('day');
    });

    it('reports billed units even when request counters are empty', async () => {
      fetchStub.resolves(
        gql({
          accountUsage: {
            summary: {
              successful: 0,
              errored: 0,
              timedout: 0,
              queued: 0,
              rejected: 0,
              maxConcurrent: 0,
              captcha: 0,
              proxy: 0,
              units: 0,
              time: 0,
            },
          },
          accountSummary: ledger,
        }),
      );

      const text = textOf(await executeFor(registerUsageTool)({}, mockContext));

      expect(text).to.include('Used: 19');
      expect(text).to.include('Included in plan: 1000');
      // The contradiction that made this look broken must be named, not implied.
      expect(text).to.include('only populated for');
      expect(text).to.include('browserless_logs');
    });

    it('summarises request counters when the account has them', async () => {
      fetchStub.resolves(
        gql({
          accountUsage: {
            summary: {
              successful: 90,
              errored: 8,
              timedout: 2,
              queued: 0,
              rejected: 0,
              maxConcurrent: 5,
              captcha: 3,
              proxy: 1024,
              units: 4200,
              time: 60000,
            },
          },
          accountSummary: ledger,
        }),
      );

      const text = textOf(await executeFor(registerUsageTool)({}, mockContext));

      expect(text).to.include('Successful: 90');
      expect(text).to.include('Peak concurrency: 5');
      expect(text).to.include('10.0% of completed requests failed');
    });

    it('forwards the key filter and timeframe', async () => {
      fetchStub.resolves(
        gql({ accountUsage: { summary: null }, accountSummary: ledger }),
      );

      await executeFor(registerUsageTool)(
        { timeframe: 'week', apiKeyIds: ['key_1', 'key_2'] },
        mockContext,
      );

      const { variables } = requestBody(fetchStub);
      expect(variables.timeframe).to.equal('week');
      expect(variables.apiKeyIds).to.deep.equal(['key_1', 'key_2']);
    });

    it('says nothing ran when there is no usage at all', async () => {
      fetchStub.resolves(
        gql({ accountUsage: { summary: null }, accountSummary: null }),
      );

      const text = textOf(await executeFor(registerUsageTool)({}, mockContext));

      expect(text).to.include('No requests recorded in this window');
    });
  });

  describe('browserless_sessions', () => {
    it('lists running browsers for action active', async () => {
      fetchStub.resolves(
        gql({
          getActiveSession: {
            sessions: [
              {
                browserId: 'br_1',
                startTime: '2026-08-17T00:00:00.000Z',
                ttl: '30000',
                browserName: 'chromium',
                type: 'cdp',
              },
            ],
            count: 1,
          },
        }),
      );

      const text = textOf(
        await executeFor(registerSessionsTool)(
          { action: 'active' },
          mockContext,
        ),
      );

      expect(text).to.include('Active sessions (1)');
      expect(text).to.include('br_1');
      expect(text).to.include('chromium');
    });

    it('explains an empty persistent list rather than looking broken', async () => {
      fetchStub.resolves(
        gql({ getPersistentSessions: { sessions: [], count: 0 } }),
      );

      const text = textOf(
        await executeFor(registerSessionsTool)(
          { action: 'persistent' },
          mockContext,
        ),
      );

      expect(text).to.include('dedicated workers');
    });

    it('never requests the apiKey field on replays', async () => {
      fetchStub.resolves(
        gql({
          sessionReplayList: {
            data: [
              {
                sessionId: 'sr_1',
                website: 'https://example.com',
                duration: 12000,
                eventCount: 42,
                timestamp: 1700000000,
                platformType: 'web',
              },
            ],
            totalCount: 1,
            page: 1,
            totalPages: 1,
          },
        }),
      );

      const text = textOf(
        await executeFor(registerSessionsTool)(
          { action: 'replays' },
          mockContext,
        ),
      );

      expect(requestBody(fetchStub).query).to.not.include('apiKey');
      expect(text).to.include('sr_1');
      expect(text).to.include('12s');
    });

    describe("action 'replay'", () => {
      const listResponse = (path: string | null) => ({
        sessionReplayList: {
          data: [
            {
              sessionId: 'sr_1',
              website: 'https://example.com',
              duration: 12000,
              eventCount: 42,
              timestamp: 1700000000,
              path: path,
            },
          ],
          totalCount: 1,
          page: 1,
          totalPages: 1,
        },
      });

      const artifact = {
        events: [
          { type: 4, data: {} },
          { type: 2, data: {} },
        ],
        website: 'https://example.com',
      };

      it('requires a sessionId', async () => {
        try {
          await executeFor(registerSessionsTool)(
            { action: 'replay' },
            mockContext,
          );
          expect.fail('expected a UserError');
        } catch (error) {
          expect((error as Error).message).to.include('sessionId is required');
        }
      });

      it('fetches the artifact from the replay CDN and attaches a player resource', async () => {
        fetchStub.onFirstCall().resolves(gql(listResponse('abc/sr_1.json')));
        fetchStub.onSecondCall().resolves(
          new Response(JSON.stringify(artifact), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const result = (await executeFor(registerSessionsTool)(
          { action: 'replay', sessionId: 'sr_1' },
          mockContext,
        )) as { content: Content[] };

        // Second call is the CDN, not the account API.
        expect(fetchStub.secondCall.args[0]).to.include('replay.example.com');
        expect(fetchStub.secondCall.args[0]).to.include('abc/sr_1.json');

        const resource = result.content.find(
          (c) => (c as { type: string }).type === 'resource',
        ) as { resource: { mimeType: string; text: string } };
        expect(resource, 'player attached as a resource').to.exist;
        expect(resource.resource.mimeType).to.equal('text/html');
        expect(resource.resource.text).to.include('rrweb-player');
        // The events must be inlined so the page plays offline.
        expect(resource.resource.text).to.include('replay-data');

        expect(textOf(result)).to.include('sr_1');
        expect(textOf(result)).to.include('2 events');
      });

      // The model must be steered to a command, not to reading the artifact:
      // it previously jq'd a 460 KB player file into the context window.
      const primeReplay = () => {
        fetchStub.onFirstCall().resolves(gql(listResponse('abc/sr_1.json')));
        fetchStub.onSecondCall().resolves(
          new Response(JSON.stringify(artifact), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };

      it('hands a local client an open command, and forbids reading the files', async () => {
        primeReplay();

        const text = textOf(
          await executeFor(registerSessionsTool)(
            { action: 'replay', sessionId: 'sr_1' },
            mockContext,
          ),
        );

        expect(text).to.match(/Already opened|open '/);
        expect(text).to.include('Do not read either file');
        expect(text).to.include('wastes the context window');
        expect(text).to.not.include('rrweb-player@');
      });

      // A remote client cannot reach a path on the server's disk, so the inline
      // copy is the only thing it can show.
      it('inlines for a remote client instead of handing over a path', async () => {
        primeReplay();

        const server = new FastMCP({ name: 'test', version: '0.1.0' });
        const spy = sinon.spy(server, 'addTool');
        registerSessionsTool(server, {
          ...mockConfig,
          transport: 'httpStream',
        });
        const result = (await (
          spy.firstCall.args[0].execute as never as (
            a: unknown,
            c: unknown,
          ) => Promise<unknown>
        )({ action: 'replay', sessionId: 'sr_1' }, mockContext)) as {
          content: Content[];
        };

        const text = (result.content[0] as { text: string }).text;
        expect(text).to.include('write the resource to a .html file');
        expect(text).to.include('never rebuild the player');
        expect(text).to.include('machine running this server');
        expect(text).to.not.include("open '");
        expect(
          result.content.some(
            (c) => (c as { type: string }).type === 'resource',
          ),
        ).to.equal(true);
      });

      it('errors clearly when the replay has no stored artifact', async () => {
        fetchStub.onFirstCall().resolves(gql(listResponse(null)));

        try {
          await executeFor(registerSessionsTool)(
            { action: 'replay', sessionId: 'sr_1' },
            mockContext,
          );
          expect.fail('expected a UserError');
        } catch (error) {
          expect((error as Error).message).to.include('No replay found');
        }
      });

      it('rejects a path that escapes the configured CDN origin', async () => {
        fetchStub
          .onFirstCall()
          .resolves(gql(listResponse('https://evil.example.com/steal.json')));

        try {
          await executeFor(registerSessionsTool)(
            { action: 'replay', sessionId: 'sr_1' },
            mockContext,
          );
          expect.fail('expected a UserError');
        } catch (error) {
          expect((error as Error).message).to.include('CDN origin');
        }
      });
    });

    it('lists 1Password integrations for action integrations', async () => {
      fetchStub.resolves(
        gql({
          listOnePasswordIntegrations: [
            {
              id: 'op_1',
              label: 'vault',
              kind: 'service-account',
              allowedDomains: ['example.com'],
              expiresAt: null,
              lastResolvedAt: null,
            },
          ],
        }),
      );

      const text = textOf(
        await executeFor(registerSessionsTool)(
          { action: 'integrations' },
          mockContext,
        ),
      );

      expect(text).to.include('vault');
      expect(text).to.include('example.com');
    });
  });

  describe('browserless_logs', () => {
    const entry = {
      timestamp: '2026-08-17T12:00:00.000Z',
      eventName: 'request.failed',
      requestId: 'req_1',
      apiKeyId: 'key_1',
      level: 'ERROR',
      endpoint: '/chromium/bql',
      category: 'browserless_refused',
      reason: 'concurrency_limit',
      message: 'Too many concurrent requests',
      url: 'https://example.com',
      status: 429,
      durationMs: 12.4,
      region: 'sfo',
      sessionId: 'sess_1',
      outcome: 'failed',
      totalUnits: 3,
    };

    it('renders entries with the failure category and reason', async () => {
      fetchStub.resolves(
        gql({ requestLogs: { entries: [entry], nextCursor: null } }),
      );

      const text = textOf(await executeFor(registerLogsTool)({}, mockContext));

      expect(text).to.include('Request logs (1)');
      expect(text).to.include('browserless_refused/concurrency_limit');
      expect(text).to.include('HTTP 429');
      expect(text).to.include('req_1');
    });

    it('sends no time bounds when none were given', async () => {
      fetchStub.resolves(
        gql({ requestLogs: { entries: [], nextCursor: null } }),
      );

      await executeFor(registerLogsTool)({}, mockContext);

      const { variables } = requestBody(fetchStub);
      expect(variables).to.not.have.property('startTime');
      expect(variables).to.not.have.property('endTime');
    });

    it('uppercases order for the RequestLogOrder enum', async () => {
      fetchStub.resolves(
        gql({ requestLogs: { entries: [], nextCursor: null } }),
      );

      await executeFor(registerLogsTool)({ order: 'desc' }, mockContext);

      expect(requestBody(fetchStub).variables.order).to.equal('DESC');
    });

    it('surfaces the paging cursor', async () => {
      fetchStub.resolves(
        gql({ requestLogs: { entries: [entry], nextCursor: 'cur_2' } }),
      );

      const text = textOf(await executeFor(registerLogsTool)({}, mockContext));

      expect(text).to.include('cur_2');
    });

    it('explains an empty result instead of erroring', async () => {
      fetchStub.resolves(
        gql({ requestLogs: { entries: [], nextCursor: null } }),
      );

      const text = textOf(await executeFor(registerLogsTool)({}, mockContext));

      expect(text).to.include('No request log entries matched');
      expect(text).to.include('depends on the account plan');
    });
  });
});
