import { expect } from 'chai';
import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
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
      },
    );

    expect(result).to.deep.equal({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('awaits successful Amplitude shutdown', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const deferred = createDeferred<void>();
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;
    shutdown.returns(deferred.promise);
    const result = shutdownAmplitudeAnalytics(mock);

    expect(
      await Promise.race([
        result.then(() => 'settled'),
        Promise.resolve('pending'),
      ]),
    ).to.equal('pending');
    deferred.resolve();
    await result;

    expect(shutdown.calledOnce).to.equal(true);
  });

  it('swallows rejected Amplitude shutdown', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const deferred = createDeferred<void>();
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;
    shutdown.returns(deferred.promise);
    const result = shutdownAmplitudeAnalytics(mock);

    expect(
      await Promise.race([
        result.then(() => 'settled'),
        Promise.resolve('pending'),
      ]),
    ).to.equal('pending');
    deferred.reject(new Error('flush failed'));
    await result;

    expect(shutdown.calledOnce).to.equal(true);
  });

  it('resolves when Amplitude shutdown never settles', async () => {
    const mock = new MockAmplitudeMCPAnalytics({
      serverName: 'browserless-mcp',
      serverVersion: '1.0.0',
    });
    const shutdown = sinon.stub(mock, 'shutdown') as sinon.SinonStub;
    shutdown.returns(new Promise<void>(() => {}));

    const result = await shutdownAmplitudeAnalytics(mock);

    expect(result).to.equal(undefined);
    expect(shutdown.calledOnce).to.equal(true);
  });
});
