import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerStripeLinkConnectTool } from '../../src/tools/link-connect.js';
import {
  registerStripeLinkCheckoutTool,
  StripeLinkCheckoutParamsSchema,
} from '../../src/tools/link-checkout.js';
import { registerAgentTools } from '../../src/tools/agent.js';
import type { McpConfig } from '../../src/@types/types.js';
import { getOrCreateSession } from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  browserlessAccountApiUrl: 'https://accounts.example.com/graphql',
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

const ownerContext = {
  ...mockContext,
  session: {
    token: 'test-token',
    apiUrl: 'https://api.example.com',
    userRole: 'owner' as const,
    identityToken: 'owner-jwt',
  },
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

const captureNamedExecute = (
  register: (server: FastMCP, config: McpConfig) => void,
  name: string,
  config = mockConfig,
) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  register(server, config);
  const definition = addToolSpy
    .getCalls()
    .map((call) => call.args[0])
    .find((candidate) => candidate.name === name);
  expect(definition, `${name} was not registered`).to.exist;
  return definition!.execute;
};

describe('Stripe Link tools', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    mockContext.reportProgress.resetHistory();
  });

  afterEach(() => sinon.restore());

  it('keeps status read-only and routes mutations through role-enforcing GraphQL', async () => {
    fetchStub.callsFake((url: string, init: RequestInit) => {
      if (String(url) === 'https://accounts.example.com/graphql') {
        const query = JSON.parse(String(init.body)).query as string;
        const field = query.includes('disconnectStripeLink')
          ? 'disconnectStripeLink'
          : 'connectStripeLink';
        return Promise.resolve(
          jsonResponse({
            data: {
              [field]: {
                status: 'not_connected',
                instruction: 'Connect Stripe Link before checkout.',
              },
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          status: 'not_connected',
          instruction: 'Connect Stripe Link before checkout.',
        }),
      );
    });
    const execute = captureExecute(registerStripeLinkConnectTool);

    await execute({ action: 'status' }, mockContext);
    await execute({ action: 'connect' }, ownerContext);
    await execute({ action: 'disconnect' }, ownerContext);

    expect(fetchStub.getCall(0).args[0]).to.include(
      '/integrations/stripe-link/status',
    );
    expect(fetchStub.getCall(0).args[1].method).to.equal('GET');
    expect(fetchStub.getCall(1).args[0]).to.equal(
      'https://accounts.example.com/graphql',
    );
    expect(fetchStub.getCall(1).args[1].method).to.equal('POST');
    expect(fetchStub.getCall(1).args[1].headers.Authorization).to.equal(
      'Bearer owner-jwt',
    );
    expect(fetchStub.getCall(2).args[0]).to.equal(
      'https://accounts.example.com/graphql',
    );
    expect(fetchStub.getCall(2).args[1].method).to.equal('POST');
  });

  it('returns only the connection contract fields', async () => {
    fetchStub.resolves(
      jsonResponse({
        data: {
          connectStripeLink: {
            status: 'not_connected',
            authorizationUrl: 'https://connect.stripe.com/setup/abc',
            instruction: 'Connect the wallet.',
            secret: 'must-not-leak',
          },
        },
      }),
    );
    const execute = captureExecute(registerStripeLinkConnectTool);

    const result = await execute({ action: 'connect' }, ownerContext);
    const text = textOf(result);
    expect(text).to.include('authorization_url');
    expect(text).to.not.include('must-not-leak');
  });

  it('denies viewer and roleless wallet mutations but allows status, owner, and admin', async () => {
    fetchStub.callsFake((url: string, init: RequestInit) => {
      if (String(url) === 'https://accounts.example.com/graphql') {
        const query = JSON.parse(String(init.body)).query as string;
        const field = query.includes('disconnectStripeLink')
          ? 'disconnectStripeLink'
          : 'connectStripeLink';
        return Promise.resolve(
          jsonResponse({
            data: {
              [field]: {
                status: 'not_connected',
                instruction: 'Connect the wallet.',
              },
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          status: 'not_connected',
          instruction: 'Connect the wallet.',
        }),
      );
    });
    const execute = captureExecute(registerStripeLinkConnectTool);
    const context = (userRole: 'owner' | 'admin' | 'viewer') => ({
      ...mockContext,
      session: {
        token: 'test-token',
        apiUrl: 'https://api.example.com',
        userRole,
        identityToken: `${userRole}-jwt`,
      },
    });
    await execute({ action: 'status' }, context('viewer'));
    for (const action of ['connect', 'disconnect'] as const) {
      try {
        await execute({ action }, context('viewer'));
        expect.fail('expected viewer mutation to fail');
      } catch (error) {
        expect((error as Error).message).to.include('owners and admins');
      }
      try {
        await execute({ action }, mockContext);
        expect.fail('expected roleless mutation to fail');
      } catch (error) {
        expect((error as Error).message).to.include('owners and admins');
      }
    }
    await execute({ action: 'connect' }, context('owner'));
    await execute({ action: 'disconnect' }, context('admin'));
    expect(fetchStub.callCount).to.equal(3);
  });

  it('rejects missing instructions and credential-bearing redirect URLs', async () => {
    const execute = captureExecute(registerStripeLinkConnectTool);
    fetchStub.resolves(
      jsonResponse({
        data: {
          connectStripeLink: {
            status: 'not_connected',
            authorizationUrl: 'https://user@app.link.com/approve/abc',
          },
        },
      }),
    );

    try {
      await execute({ action: 'connect' }, ownerContext);
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

  it('refuses to close the browser while the checkout has a resumable continuation', async () => {
    const browser = await makeRespondingServer(() => ({
      status: 'pending_approval',
      approval_url: 'https://app.link.com/approve/abc',
      instruction: 'Approve the payment.',
      checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
      _next: {
        action: 'resume',
        checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
        valid_until: '2099-08-18T00:00:00.000Z',
      },
    }));
    try {
      const config = {
        ...mockConfig,
        browserlessApiUrl: browser.url,
      };
      const session = await getOrCreateSession(
        'link-close-guard',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      const agent = captureNamedExecute(
        registerAgentTools,
        'browserless_agent',
        config,
      );

      await checkout(
        {
          action: 'create',
          browser_session_handle: session.handle,
          merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
          amount_minor: 1_000,
          currency: 'usd',
          cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
          selectors: {
            number: 'input[name=cardnumber]',
            expiry: 'input[name=exp-date]',
            cvc: 'input[name=cvc]',
          },
        },
        mockContext,
      );

      let error: unknown;
      try {
        await agent(
          { method: 'close', params: {}, sessionId: session.handle },
          mockContext,
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(
        /pending.*checkout.*resume|cancel/i,
      );
    } finally {
      await browser.close();
    }
  });

  it('allows only one active Stripe Link checkout per browser session', async () => {
    const checkoutId = 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF';
    let checkoutCalls = 0;
    const browser = await makeRespondingServer(() => {
      checkoutCalls++;
      return {
        status: 'pending_approval',
        approval_url: 'https://app.link.com/approve/abc',
        instruction: 'Approve the payment.',
        checkout_id: checkoutId,
        _next: {
          action: 'resume',
          checkout_id: checkoutId,
          valid_until: '2099-08-18T00:00:00.000Z',
        },
      };
    });
    try {
      const config = { ...mockConfig, browserlessApiUrl: browser.url };
      const session = await getOrCreateSession(
        'link-single-active',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      const create = {
        action: 'create' as const,
        browser_session_handle: session.handle,
        merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
        amount_minor: 1_000,
        currency: 'usd' as const,
        cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
        selectors: {
          number: 'input[name=cardnumber]',
          expiry: 'input[name=exp-date]',
          cvc: 'input[name=cvc]',
        },
      };

      await checkout(create, mockContext);
      let error: unknown;
      try {
        await checkout(create, mockContext);
      } catch (caught) {
        error = caught;
      }

      expect((error as Error).message).to.match(
        /already active.*resume.*cancel/i,
      );
      expect(checkoutCalls).to.equal(1);
      expect(session.stripeLinkContinuation).to.deep.equal({
        checkoutId,
        allowedNextAction: 'resume',
      });
    } finally {
      await browser.close();
    }
  });

  it('serializes concurrent creates and keeps exactly one continuation', async () => {
    const checkoutId = 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF';
    let checkoutCalls = 0;
    const browser = await makeRespondingServer(() => {
      checkoutCalls++;
      return {
        status: 'pending_approval',
        approval_url: 'https://app.link.com/approve/abc',
        instruction: 'Approve the payment.',
        checkout_id: checkoutId,
        _next: {
          action: 'resume',
          checkout_id: checkoutId,
          valid_until: '2099-08-18T00:00:00.000Z',
        },
      };
    });
    try {
      const config = { ...mockConfig, browserlessApiUrl: browser.url };
      const session = await getOrCreateSession(
        'link-concurrent-create',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      const create = {
        action: 'create' as const,
        browser_session_handle: session.handle,
        merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
        amount_minor: 1_000,
        currency: 'usd' as const,
        cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
        selectors: {
          number: 'input[name=cardnumber]',
          expiry: 'input[name=exp-date]',
          cvc: 'input[name=cvc]',
        },
      };

      const results = await Promise.allSettled([
        checkout(create, mockContext),
        checkout(create, mockContext),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).to.have.length(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).to.have.length(1);
      expect(checkoutCalls).to.equal(1);
      expect(session.stripeLinkContinuation).to.deep.equal({
        checkoutId,
        allowedNextAction: 'resume',
      });
    } finally {
      await browser.close();
    }
  });

  it('rejects mismatched checkout ids and out-of-order actions before dispatch', async () => {
    const checkoutId = 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF';
    let checkoutCalls = 0;
    const browser = await makeRespondingServer(() => {
      checkoutCalls++;
      return {
        status: 'pending_approval',
        approval_url: 'https://app.link.com/approve/abc',
        instruction: 'Approve the payment.',
        checkout_id: checkoutId,
        _next: {
          action: 'resume',
          checkout_id: checkoutId,
          valid_until: '2099-08-18T00:00:00.000Z',
        },
      };
    });
    try {
      const config = { ...mockConfig, browserlessApiUrl: browser.url };
      const session = await getOrCreateSession(
        'link-mismatched-continuation',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      await checkout(
        {
          action: 'create',
          browser_session_handle: session.handle,
          merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
          amount_minor: 1_000,
          currency: 'usd',
          cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
          selectors: {
            number: 'input[name=cardnumber]',
            expiry: 'input[name=exp-date]',
            cvc: 'input[name=cvc]',
          },
        },
        mockContext,
      );

      for (const request of [
        {
          action: 'resume',
          browser_session_handle: session.handle,
          checkout_id: 'lkco_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
        },
        {
          action: 'report',
          browser_session_handle: session.handle,
          checkout_id: checkoutId,
          outcome: 'success',
        },
      ]) {
        let error: unknown;
        try {
          await checkout(request, mockContext);
        } catch (caught) {
          error = caught;
        }
        expect((error as Error).message).to.match(
          /does not match|must resume next/i,
        );
      }
      expect(checkoutCalls).to.equal(1);
    } finally {
      await browser.close();
    }
  });

  it('does not retain a terminal checkout response with a forged resume hint', async () => {
    const checkoutId = 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF';
    const browser = await makeRespondingServer(() => ({
      status: 'succeeded',
      instruction: 'Checkout completed.',
      checkout_id: checkoutId,
      _next: {
        action: 'resume',
        checkout_id: checkoutId,
        valid_until: '2099-08-18T00:00:00.000Z',
      },
    }));
    try {
      const config = { ...mockConfig, browserlessApiUrl: browser.url };
      const session = await getOrCreateSession(
        'link-terminal-next',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      let error: unknown;
      try {
        await checkout(
          {
            action: 'create',
            browser_session_handle: session.handle,
            merchant: {
              name: 'Shop',
              url: 'https://shop.example.com/checkout',
            },
            amount_minor: 1_000,
            currency: 'usd',
            cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
            selectors: {
              number: 'input[name=cardnumber]',
              expiry: 'input[name=exp-date]',
              cvc: 'input[name=cvc]',
            },
          },
          mockContext,
        );
      } catch (caught) {
        error = caught;
      }

      expect((error as Error).message).to.match(/invalid checkout next step/i);
      expect(session.stripeLinkContinuation).to.equal(undefined);
    } finally {
      await browser.close();
    }
  });

  it('advances sanitized session state from resume to report and clears it after reporting', async () => {
    const checkoutId = 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF';
    const browser = await makeRespondingServer((_method, rawParams) => {
      const params = rawParams as { action?: string };
      if (params.action === 'create') {
        return {
          status: 'pending_approval',
          approval_url: 'https://app.link.com/approve/abc',
          instruction: 'Approve the payment.',
          checkout_id: checkoutId,
          _next: {
            action: 'resume',
            checkout_id: checkoutId,
            valid_until: '2099-08-18T00:00:00.000Z',
          },
        };
      }
      if (params.action === 'resume') {
        return {
          status: 'filled',
          instruction: 'Submit the merchant order.',
          checkout_id: checkoutId,
          last4: '4242',
        };
      }
      return {
        status: 'succeeded',
        instruction: 'Checkout outcome recorded.',
        last4: '4242',
      };
    });
    try {
      const config = { ...mockConfig, browserlessApiUrl: browser.url };
      const session = await getOrCreateSession(
        'link-report-state',
        browser.url,
        mockConfig.browserlessToken!,
      );
      const checkout = captureExecute(registerStripeLinkCheckoutTool, config);
      const agent = captureNamedExecute(
        registerAgentTools,
        'browserless_agent',
        config,
      );

      await checkout(
        {
          action: 'create',
          browser_session_handle: session.handle,
          merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
          amount_minor: 1_000,
          currency: 'usd',
          cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 1_000 }],
          selectors: {
            number: 'input[name=cardnumber]',
            expiry: 'input[name=exp-date]',
            cvc: 'input[name=cvc]',
          },
        },
        mockContext,
      );
      expect(session.stripeLinkContinuation).to.deep.equal({
        checkoutId,
        allowedNextAction: 'resume',
      });

      await checkout(
        {
          action: 'resume',
          browser_session_handle: session.handle,
          checkout_id: checkoutId,
        },
        mockContext,
      );
      expect(session.stripeLinkContinuation).to.deep.equal({
        checkoutId,
        allowedNextAction: 'report',
      });

      await checkout(
        {
          action: 'report',
          browser_session_handle: session.handle,
          checkout_id: checkoutId,
          outcome: 'success',
        },
        mockContext,
      );
      expect(session.stripeLinkContinuation).to.equal(undefined);
      expect(
        textOf(
          await agent(
            { method: 'close', params: {}, sessionId: session.handle },
            mockContext,
          ),
        ),
      ).to.include('Browser session closed');
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

  it('keeps only validated requires-action handoffs and resume semantics', async () => {
    let calls = 0;
    const browser = await makeRespondingServer(() =>
      calls++ === 0
        ? {
            status: 'requires_action',
            checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
            action_type: 'three_d_secure',
            action_resolution: 'auto_resume',
            action_message: 'Complete 3D Secure verification.',
            action_url: 'https://app.link.com/finish_setup?verify=3ds',
            instruction: 'Complete 3D Secure verification.',
            _next: {
              action: 'resume',
              checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
              valid_until: '2099-08-18T00:00:00.000Z',
            },
          }
        : {
            status: 'requires_action',
            checkout_id: 'lkco_abcdefghijklmnopqrstuvwxyzABCDEF',
            action_type: 'add_payment_method',
            action_resolution: 'create_new_spend_request',
            action_message: 'Add a payment method in Link.',
            instruction: 'Add a payment method in Link.',
          },
    );
    try {
      const session = await getOrCreateSession(
        'link-action-response',
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
      session.stripeLinkContinuation = {
        checkoutId: params.checkout_id,
        allowedNextAction: 'resume',
      };
      const auto = JSON.parse(textOf(await execute(params, mockContext)));
      expect(auto.action_url).to.equal(
        'https://app.link.com/finish_setup?verify=3ds',
      );
      expect(auto.action_message).to.equal('Complete 3D Secure verification.');
      expect(auto._next.action).to.equal('resume');
      session.skillState.fired.set('agentic-checkout', 1);
      const createNew = JSON.parse(textOf(await execute(params, mockContext)));
      expect(createNew.action_resolution).to.equal('create_new_spend_request');
      expect(createNew.action_message).to.equal(
        'Add a payment method in Link.',
      );
      expect(createNew).not.to.have.property('action_url');
      expect(createNew).not.to.have.property('_next');
      expect(session.skillState.fired.has('agentic-checkout')).to.be.false;
    } finally {
      await browser.close();
    }
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
      session.stripeLinkContinuation = {
        checkoutId: params.checkout_id,
        allowedNextAction: 'resume',
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
