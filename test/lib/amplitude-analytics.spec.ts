import { expect } from 'chai';
import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
import { createToolContext, runWithContext } from '@amplitude/mcp-analytics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { FastMCP } from 'fastmcp';
import sinon from 'sinon';
import {
  getAmplitudeIdentity,
  initializeAmplitudeAnalytics,
  instrumentFastMcpTools,
  resetAmplitudeAnalyticsForTests,
  shutdownAmplitudeAnalytics,
} from '../../src/lib/amplitude-analytics.js';
import { defineTool } from '../../src/lib/define-tool.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import type { McpConfig } from '../../src/@types/types.js';
import { z } from 'zod';

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('Amplitude MCP analytics', () => {
  const originalConnect = Server.prototype.connect;

  afterEach(() => {
    resetAmplitudeAnalyticsForTests(originalConnect);
  });

  it('is disabled without an API key', () => {
    let constructed = false;
    const analytics = initializeAmplitudeAnalytics(undefined, '1.0.0', () => {
      constructed = true;
      return new MockAmplitudeMCPAnalytics({
        serverName: 'test',
        serverVersion: '1.0.0',
      });
    });

    expect(analytics).to.equal(undefined);
    expect(constructed).to.equal(false);
  });

  it('uses account ids or hashed tokens as identity', () => {
    const token = 'plain-browserless-token';
    expect(
      getAmplitudeIdentity({ token, apiUrl: 'https://example.com' }, token),
    ).to.equal('token-Hv-TiXSqe4TOtrWa7FLy8hqVC8ermzWq7wKnBgIHrX8');
    expect(
      getAmplitudeIdentity(
        { token, apiUrl: 'https://example.com', accountId: 'account-123' },
        token,
      ),
    ).to.equal('account-123');
    expect(
      getAmplitudeIdentity({ token, apiUrl: 'https://example.com' }, token),
    ).to.not.equal(token);
  });

  it('instruments a connected SDK server without recursing', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const instrumentServer = sinon.spy(mock, 'instrumentServer');
    const connect = sinon.spy(originalConnect);
    Server.prototype.connect = connect;
    initializeAmplitudeAnalytics('test-key', '1.0.0', () => mock);

    const server = new Server({ name: 'test', version: '1.0.0' });
    await server.connect({
      start: async () => undefined,
      close: async () => undefined,
      send: async () => undefined,
    });

    expect(instrumentServer.calledOnceWithExactly(server)).to.equal(true);
    expect(connect.calledOnce).to.equal(true);
  });

  it('instruments FastMCP tools once and skips instrumentation when disabled', () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const instrumentTool = sinon.spy(mock, 'instrumentTool');
    const server = new FastMCP({ name: 'test', version: '1.0.0' });
    const addTool = sinon.spy(server, 'addTool');
    const execute = async () => ({ content: [] });

    instrumentFastMcpTools(server, mock);
    server.addTool({
      name: 'test_tool',
      parameters: z.object({}),
      execute,
    });

    expect(instrumentTool.calledOnce).to.equal(true);
    expect(instrumentTool.firstCall.args[1]).to.deep.equal({
      name: 'test_tool',
    });
    expect(addTool.firstCall.args[0].execute).to.not.equal(execute);

    const disabledMock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const disabledInstrumentTool = sinon.spy(disabledMock, 'instrumentTool');
    const disabledServer = new FastMCP({
      name: 'disabled-test',
      version: '1.0.0',
    });
    const disabledAddTool = sinon.spy(disabledServer, 'addTool');
    const disabledExecute = async () => ({ content: [] });

    instrumentFastMcpTools(disabledServer, undefined);
    disabledServer.addTool({
      name: 'disabled_tool',
      parameters: z.object({}),
      execute: disabledExecute,
    });

    expect(disabledInstrumentTool.notCalled).to.equal(true);
    expect(disabledAddTool.firstCall.args[0].execute).to.equal(disabledExecute);
  });

  it('executes a defined tool normally when analytics is disabled', async () => {
    const server = new FastMCP({ name: 'disabled-test', version: '1.0.0' });
    const addTool = sinon.spy(server, 'addTool');
    const config = {
      browserlessApiUrl: 'https://example.com',
      complianceMode: true,
    } as McpConfig;

    defineTool(server, config, undefined, {
      name: 'disabled_tool',
      description: 'Disabled analytics test',
      parameters: z.object({}),
      run: async () => 'ok',
      format: (result) => [{ type: 'text', text: result }],
    });

    const tool = addTool.firstCall.args[0];
    const result = await tool.execute(
      {},
      {
        reportProgress: async () => undefined,
        session: { token: 'test-token', apiUrl: 'https://example.com' },
        sessionId: undefined,
        log: {
          debug: () => undefined,
          error: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
        client: { version: { name: 'test-client', version: '1.0.0' } },
        streamContent: async () => undefined,
        elicit: async () => ({ action: 'cancel' as const }),
      },
    );

    expect(result).to.deep.equal({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('awaits the Amplitude flush, then shuts the client down', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const deferred = createDeferred<void>();
    const flush = sinon.stub(mock, 'flush') as sinon.SinonStub;
    flush.returns({ promise: deferred.promise });
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;
    const result = shutdownAmplitudeAnalytics(mock);

    expect(
      await Promise.race([
        result.then(() => 'settled'),
        Promise.resolve('pending'),
      ]),
    ).to.equal('pending');
    expect(shutdown.notCalled).to.equal(true);
    deferred.resolve();
    await result;

    expect(flush.calledOnce).to.equal(true);
    expect(shutdown.calledOnce).to.equal(true);
  });

  it('swallows a rejected Amplitude flush', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const deferred = createDeferred<void>();
    const flush = sinon.stub(mock, 'flush') as sinon.SinonStub;
    flush.returns({ promise: deferred.promise });
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;
    const result = shutdownAmplitudeAnalytics(mock);

    expect(
      await Promise.race([
        result.then(() => 'settled'),
        Promise.resolve('pending'),
      ]),
    ).to.equal('pending');
    deferred.reject(new Error('flush failed'));
    await result;

    expect(flush.calledOnce).to.equal(true);
    expect(shutdown.calledOnce).to.equal(true);
  });

  it('resolves when the Amplitude flush never settles', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const flush = sinon.stub(mock, 'flush') as sinon.SinonStub;
    flush.returns({ promise: new Promise<void>(() => {}) });
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;

    const result = await shutdownAmplitudeAnalytics(mock);

    expect(result).to.equal(undefined);
    expect(flush.calledOnce).to.equal(true);
    expect(shutdown.calledOnce).to.equal(true);
  });

  describe('custom events', () => {
    const toolCtx = () =>
      createToolContext(
        {
          server: { name: 'browserless-mcp', version: '1.0.0' },
          transport: 'stdio',
          identity: { userId: 'account-123', resolvedFrom: 'explicit' },
        },
        { name: 'browserless_scrape' },
      );

    it('routes MCP Tool Request through the Amplitude client', () => {
      const mock = new MockAmplitudeMCPAnalytics({
        serverName: 'browserless-mcp',
        serverVersion: '1.0.0',
      });
      const trackToolEvent = sinon.spy(mock, 'trackToolEvent');
      initializeAmplitudeAnalytics('test-key', '1.0.0', () => mock);
      const helper = new AnalyticsHelper(false);

      runWithContext(toolCtx(), () => {
        helper.fireToolRequest('plain-token', 'browserless_scrape', {
          api_url: 'https://example.com',
          success: true,
          _prompt: 'why the agent called this',
        });
      });

      expect(trackToolEvent.calledOnce).to.equal(true);
      expect(trackToolEvent.firstCall.args[1]).to.equal('MCP Tool Request');
      const props = trackToolEvent.firstCall.args[2] as Record<string, unknown>;
      // Raw token never leaves via Amplitude; rationale rides `[MCP] Rationale`.
      expect(props).to.deep.equal({
        tool: 'browserless_scrape',
        api_url: 'https://example.com',
        success: true,
      });
    });

    it('routes MCP Skill through the Amplitude client', () => {
      const mock = new MockAmplitudeMCPAnalytics({
        serverName: 'browserless-mcp',
        serverVersion: '1.0.0',
      });
      const trackToolEvent = sinon.spy(mock, 'trackToolEvent');
      initializeAmplitudeAnalytics('test-key', '1.0.0', () => mock);
      const helper = new AnalyticsHelper(false);

      runWithContext(toolCtx(), () => {
        helper.fireSkill('plain-token', { skill: 'autonomous-login' });
      });

      expect(trackToolEvent.calledOnce).to.equal(true);
      expect(trackToolEvent.firstCall.args[1]).to.equal('MCP Skill');
      expect(trackToolEvent.firstCall.args[2]).to.deep.equal({
        skill: 'autonomous-login',
      });
    });

    it('emits nothing when Amplitude is disabled or outside a tool frame', () => {
      const mock = new MockAmplitudeMCPAnalytics({
        serverName: 'browserless-mcp',
        serverVersion: '1.0.0',
      });
      const trackToolEvent = sinon.spy(mock, 'trackToolEvent');
      const helper = new AnalyticsHelper(false);

      // Disabled: no client was ever initialized.
      runWithContext(toolCtx(), () => {
        helper.fireToolRequest('plain-token', 'browserless_scrape', {});
      });
      expect(trackToolEvent.notCalled).to.equal(true);

      // Enabled, but no ambient context (e.g. a non-tool code path).
      initializeAmplitudeAnalytics('test-key', '1.0.0', () => mock);
      helper.fireToolRequest('plain-token', 'browserless_scrape', {});
      expect(trackToolEvent.notCalled).to.equal(true);
    });
  });
});
