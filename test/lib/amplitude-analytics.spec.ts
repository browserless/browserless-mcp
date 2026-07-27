import { expect } from 'chai';
import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import sinon from 'sinon';
import {
  getAmplitudeIdentity,
  initializeAmplitudeAnalytics,
  resetAmplitudeAnalyticsForTests,
} from '../../src/lib/amplitude-analytics.js';
import { djb2 } from '../../src/lib/utils.js';

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
    ).to.equal(`token-${djb2(token)}`);
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
});
