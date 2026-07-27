import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { FastMCP } from 'fastmcp';
import sinon from 'sinon';
import {
  getAmplitudeIdentity,
  initializeAmplitudeAnalytics,
  instrumentFastMcpTools,
  resetAmplitudeAnalyticsForTests,
} from '../../src/lib/amplitude-analytics.js';
import { z } from 'zod';

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
    ).to.equal(
      `token-${createHash('sha256').update(token).digest('base64url')}`,
    );
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
});
