import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import * as agent from '../../src/tools/agent.js';
import { getConfig } from '../../src/config.js';
import { createApiClient } from '../../src/lib/api-client.js';
import {
  AgentErrorFrame,
  makeRespondingServer,
} from '../helpers/upgrade-server.js';

describe('shared agent command engine', () => {
  it('exposes raw results and the one-shot close notice with default agent options', async () => {
    const ws = await makeRespondingServer(() => ({
      text: 'page text',
      time: 7,
    }));
    try {
      const config = {
        ...getConfig(),
        browserlessToken: 'test-token',
        complianceMode: true,
        browserlessApiUrl: ws.url,
      };
      const result = await (agent as any).runAgentCommands(
        {
          client: createApiClient(config),
          params: { commands: [{ method: 'text' }] },
          log: { info() {}, warn() {}, error() {}, debug() {} },
          token: 'test-token',
          apiUrl: ws.url,
          mcpSource: {},
          sessionId: undefined,
        },
        config,
        agent.AGENT_RUN_OPTIONS,
      );
      expect(result.results).to.deep.equal([
        { method: 'text', params: {}, result: { text: 'page text', time: 7 } },
      ]);
      expect(JSON.stringify(result.content)).to.contain(
        'Browser session closed (one-shot).',
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(ws.closedConnections()).to.equal(1);
    } finally {
      await ws.close();
    }
  });

  it('exposes raw results without follow-up text or automatic downloads', async () => {
    expect(agent).to.have.property('runAgentCommands').that.is.a('function');
    const methods: string[] = [];
    const outbound: unknown[] = [];
    const ws = await makeRespondingServer((method, params) => {
      methods.push(method);
      outbound.push(params);
      return method === 'goto'
        ? { url: 'https://example.com', status: 200 }
        : { text: 'page text', time: 7 };
    });
    try {
      const config = {
        ...getConfig(),
        browserlessToken: 'test-token',
        complianceMode: true,
        browserlessApiUrl: ws.url,
      };
      const run = (agent as any).runAgentCommands;
      const result = await run(
        {
          client: createApiClient(config),
          prompt: 'Read the public page',
          params: {
            commands: [
              { method: 'goto', params: { url: 'https://example.com' } },
              { method: 'text' },
            ],
          },
          log: { info() {}, warn() {}, error() {}, debug() {} },
          token: 'test-token',
          apiUrl: ws.url,
          mcpSource: {},
          sessionId: undefined,
        },
        config,
        {
          toolName: 'browserless_read_page',
          replies: { sessionLine: () => '', oneShotClosedNotice: () => '' },
          extras: false,
          closeAfter: 'always',
        },
      );
      expect(result.results.map((r: any) => r.method)).to.deep.equal([
        'goto',
        'text',
      ]);
      expect(result.results[1].result).to.deep.equal({
        text: 'page text',
        time: 7,
      });
      expect(JSON.stringify(result.content)).not.to.match(
        /sessionId|reportOutcome|SKILL|REPETITION/,
      );
      expect(methods).to.deep.equal(['goto', 'text']);
      expect(outbound).to.deep.equal([{ url: 'https://example.com' }, {}]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(ws.closedConnections()).to.equal(1);
    } finally {
      await ws.close();
    }
  });

  for (const closeAfter of ['always', 'success']) {
    it(`preserves classified errors and applies ${closeAfter} cleanup`, async () => {
      expect(agent).to.have.property('runAgentCommands').that.is.a('function');
      const ws = await makeRespondingServer(
        () =>
          new AgentErrorFrame({
            code: 'SELECTOR_NOT_FOUND',
            message: 'Missing selector',
          }),
      );
      try {
        const config = {
          ...getConfig(),
          browserlessToken: 'test-token',
          complianceMode: true,
          browserlessApiUrl: ws.url,
        };
        const fire = sinon.spy();
        let error: any;
        try {
          await (agent as any).runAgentCommands(
            {
              client: createApiClient(config),
              params: { commands: [{ method: 'text' }] },
              log: { info() {}, warn() {}, error() {}, debug() {} },
              token: 'test-token',
              apiUrl: ws.url,
              mcpSource: {},
              sessionId: undefined,
              analytics: { fireToolRequest: fire },
            },
            config,
            { ...(agent as any).AGENT_RUN_OPTIONS, closeAfter },
          );
        } catch (caught) {
          error = caught;
        }
        expect(error).to.be.instanceOf(agent.AgentRunError);
        expect(error).to.be.instanceOf(UserError);
        expect(error.reason).to.deep.equal({
          kind: 'command',
          detail: 'Missing selector',
        });
        expect(error.message).to.contain('Missing selector');
        expect(fire.firstCall.args[1]).to.equal('browserless_agent');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(ws.closedConnections()).to.equal(
          closeAfter === 'always' ? 1 : 0,
        );
        const server = new FastMCP({ name: 'test', version: '0.1.0' });
        const addTool = sinon.spy(server, 'addTool');
        agent.registerAgentTools(server, config);
        const tool = addTool
          .getCalls()
          .find((call) => call.args[0].name === 'browserless_agent')!.args[0];
        let directError: any;
        try {
          await tool.execute({ commands: [{ method: 'text' }] }, {
            reportProgress: async () => {},
            log: { info() {}, warn() {}, error() {}, debug() {} },
          } as any);
        } catch (caught) {
          directError = caught;
        }
        expect(directError).to.be.instanceOf(UserError);
        expect(error.message.replace(/s:[0-9a-f-]{36}/g, 's:SESSION')).to.equal(
          directError.message.replace(/s:[0-9a-f-]{36}/g, 's:SESSION'),
        );
      } finally {
        await ws.close();
      }
    });
  }
});
