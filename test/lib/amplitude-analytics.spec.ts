import { expect } from 'chai';
import { MockAmplitudeMCPAnalytics } from '@amplitude/mcp-analytics/testing';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  getAmplitudeAnalytics,
  getAmplitudeIdentity,
  initializeAmplitudeAnalytics,
} from '../../src/lib/amplitude-analytics.js';
import { djb2 } from '../../src/lib/utils.js';

describe('Amplitude MCP analytics', () => {
  it('is disabled without an API key', () => {
    let constructed = false;
    const analytics = initializeAmplitudeAnalytics(undefined, '1.0.0', () => {
      constructed = true;
      return new MockAmplitudeMCPAnalytics({
        serverName: 'test',
        serverVersion: '1.0.0',
      }) as never;
    });

    expect(analytics).to.equal(undefined);
    expect(constructed).to.equal(false);
  });

  it('uses account ids or hashed tokens as identity', () => {
    const token = 'plain-browserless-token';
    expect(
      getAmplitudeIdentity({ token, apiUrl: 'https://example.com' }, token),
    ).to.equal(String(djb2(token)));
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
    initializeAmplitudeAnalytics('test-key', '1.0.0', () => mock as never);

    const server = new Server({ name: 'test', version: '1.0.0' });
    await server.connect({
      start: async () => undefined,
      close: async () => undefined,
      send: async () => undefined,
    });

    const wrapped = mock.instrumentTool(
      async (_args: Record<string, unknown>, _extra: unknown) => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
      { name: 'search' },
    );
    await wrapped({}, { sessionId: 'session-1' } as never);

    expect(getAmplitudeAnalytics()).to.equal(mock);
    expect(mock.getEvents('[MCP] Tool Call Response')).to.have.length(1);
  });
});
