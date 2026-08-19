import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerStripeLinkConnectTool } from '../../src/tools/link-connect.js';
import {
  registerStripeLinkCheckoutTool,
  StripeLinkCheckoutParamsSchema,
} from '../../src/tools/link-checkout.js';
import type { McpConfig } from '../../src/@types/types.js';
import { getOrCreateSession } from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 3,
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

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const textOf = (result: unknown): string =>
  ((result as { content: Content[] }).content[0] as { text: string }).text;

const captureExecute = (
  register: (server: FastMCP, config: McpConfig) => void,
  config = mockConfig,
) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  register(server, config);
  return addToolSpy.firstCall.args[0].execute;
};

describe('Stripe Link tools', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    mockContext.reportProgress.resetHistory();
  });

  afterEach(() => sinon.restore());

  it('maps status, connect, and disconnect to the locked REST routes', async () => {
    fetchStub.callsFake(() =>
      Promise.resolve(
        jsonResponse({
          status: 'not_connected',
          instruction: 'Connect Stripe Link before checkout.',
        }),
      ),
    );
    const execute = captureExecute(registerStripeLinkConnectTool);

    await execute({ action: 'status' }, mockContext);
    await execute({ action: 'connect' }, mockContext);
    await execute({ action: 'disconnect' }, mockContext);

    expect(fetchStub.getCall(0).args[0]).to.include(
      '/integrations/stripe-link/status',
    );
    expect(fetchStub.getCall(0).args[1].method).to.equal('GET');
    expect(fetchStub.getCall(1).args[0]).to.include(
      '/integrations/stripe-link/authorize',
    );
    expect(fetchStub.getCall(1).args[1].method).to.equal('POST');
    expect(fetchStub.getCall(2).args[0]).to.include(
      '/integrations/stripe-link/disconnect',
    );
    expect(fetchStub.getCall(2).args[1].method).to.equal('DELETE');
  });

  it('returns only the connection contract fields', async () => {
    fetchStub.resolves(
      jsonResponse({
        status: 'not_connected',
        authorization_url: 'https://connect.stripe.com/setup/abc',
        instruction: 'Connect the wallet.',
        secret: 'must-not-leak',
      }),
    );
    const execute = captureExecute(registerStripeLinkConnectTool);

    const result = await execute({ action: 'connect' }, mockContext);
    const text = textOf(result);
    expect(text).to.include('authorization_url');
    expect(text).to.not.include('must-not-leak');
  });

  it('rejects missing instructions and credential-bearing redirect URLs', async () => {
    const execute = captureExecute(registerStripeLinkConnectTool);
    fetchStub.resolves(
      jsonResponse({
        status: 'not_connected',
        authorization_url: 'https://user@app.link.com/approve/abc',
      }),
    );

    try {
      await execute({ action: 'connect' }, mockContext);
      expect.fail('expected an invalid Stripe Link response');
    } catch (error) {
      expect((error as Error).message).to.match(/Stripe Link|untrusted/);
    }
  });

  it('rejects a mismatched cart total before checkout is called', async () => {
    const input = {
      action: 'create' as const,
      browser_session_handle: 's:checkout-session',
      merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
      amount_minor: 1200,
      currency: 'usd' as const,
      cart: [{ name: 'Item', quantity: 2, unit_amount_minor: 500 }],
      selectors: {
        number: 'input[name=cardnumber]',
        expiry: 'input[name=exp-date]',
        cvc: 'input[name=cvc]',
      },
    };
    expect(StripeLinkCheckoutParamsSchema.safeParse(input).success).to.be.false;

    const execute = captureExecute(registerStripeLinkCheckoutTool);
    try {
      await execute(input, mockContext);
      expect.fail('expected checkout total validation to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'amount_minor must equal the sum',
      );
    }
    expect(fetchStub.called).to.be.false;
  });

  it('uses the exact open agent WebSocket and returns only data-only continuation state', async () => {
    let sent: { method: string; params: unknown } | undefined;
    const browser = await makeRespondingServer((method, params) => {
      sent = { method, params };
      return {
        status: 'pending_approval',
        approval_url: 'https://app.link.com/approve/abc',
        instruction: 'Approve the payment.',
        checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
        _next: {
          action: 'resume',
          checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
          valid_until: '2099-08-18T00:00:00.000Z',
        },
        card_number: '4242424242424242',
      };
    });
    try {
      const session = await getOrCreateSession(
        'link-checkout',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const execute = captureExecute(registerStripeLinkCheckoutTool, {
        ...mockConfig,
        browserlessApiUrl: browser.url,
      });
      const input = {
        action: 'create' as const,
        browser_session_handle: session.handle,
        merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
        amount_minor: 1000,
        currency: 'usd' as const,
        cart: [{ name: 'Item', quantity: 2, unit_amount_minor: 500 }],
        selectors: {
          number: 'input[name=cardnumber]',
          expiry: 'input[name=exp-date]',
          cvc: 'input[name=cvc]',
        },
      };

      const result = await execute(input, mockContext);

      expect(sent?.method).to.equal('stripeLinkCheckout');
      expect(sent?.params).to.deep.equal({
        action: 'create',
        merchant: input.merchant,
        amount_minor: 1000,
        currency: 'usd',
        cart: input.cart,
        selectors: input.selectors,
      });
      expect(textOf(result)).to.include('"action": "resume"');
      expect(textOf(result)).to.not.include('"command"');
      expect(textOf(result)).to.not.include('4242424242424242');
      expect(fetchStub.called).to.be.false;
      expect(session.skillState.fired.has('agentic-checkout')).to.be.true;
    } finally {
      await browser.close();
    }
  });

  it('fails closed for an unknown browser handle without opening or calling checkout', async () => {
    const execute = captureExecute(registerStripeLinkCheckoutTool);
    let error: unknown;
    try {
      await execute(
        {
          action: 'resume',
          browser_session_handle: 's:missing-session',
          checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
        },
        mockContext,
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.match(/not open|Resume it/);
    expect(fetchStub.called).to.be.false;
  });

  it('rejects executable next steps and drops malformed last4', async () => {
    let calls = 0;
    const browser = await makeRespondingServer(() =>
      calls++ === 0
        ? {
            status: 'pending_approval',
            _next: {
              command: 'spend-request retrieve lsrq_secret',
              until: 'approved',
            },
          }
        : { status: 'filled', last4: '4242424242424242' },
    );
    try {
      const session = await getOrCreateSession(
        'link-malicious-response',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const execute = captureExecute(registerStripeLinkCheckoutTool, {
        ...mockConfig,
        browserlessApiUrl: browser.url,
      });
      const params = {
        action: 'resume' as const,
        browser_session_handle: session.handle,
        checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
      };
      let error: unknown;
      try {
        await execute(params, mockContext);
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).to.match(/next step/);
      expect(textOf(await execute(params, mockContext))).to.not.include(
        'last4',
      );
    } finally {
      await browser.close();
    }
  });
});
