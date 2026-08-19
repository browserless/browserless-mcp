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
) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  register(server, mockConfig);
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
      merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
      amount_minor: 1200,
      currency: 'usd' as const,
      cart: [{ name: 'Item', quantity: 2, unit_amount_minor: 500 }],
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

  it('posts the exact checkout body and sanitizes last4', async () => {
    fetchStub.resolves(
      jsonResponse({
        status: 'approval_required',
        approval_url: 'https://checkout.stripe.com/approve/abc',
        instruction: 'Approve the payment.',
        _next: {
          command:
            'spend-request retrieve lsrq_abc --interval 2 --max-attempts 300',
          until: 'status changes from pending_approval',
        },
        last4: '4242',
        card_number: '4242424242424242',
      }),
    );
    const execute = captureExecute(registerStripeLinkCheckoutTool);
    const input = {
      merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
      amount_minor: 1000,
      currency: 'usd' as const,
      cart: [{ name: 'Item', quantity: 2, unit_amount_minor: 500 }],
    };

    const result = await execute(input, mockContext);

    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/integrations/stripe-link/checkout');
    expect(options.method).to.equal('POST');
    expect(JSON.parse(options.body)).to.deep.equal(input);
    expect(textOf(result)).to.include('"last4": "4242"');
    expect(textOf(result)).to.not.include('4242424242424242');
  });

  it('drops a malformed last4 instead of exposing it', async () => {
    fetchStub.resolves(
      jsonResponse({ status: 'complete', last4: '4242424242424242' }),
    );
    const execute = captureExecute(registerStripeLinkCheckoutTool);
    const result = await execute(
      {
        merchant: { name: 'Shop', url: 'https://shop.example.com/checkout' },
        amount_minor: 500,
        currency: 'usd',
        cart: [{ name: 'Item', quantity: 1, unit_amount_minor: 500 }],
      },
      mockContext,
    );

    expect(textOf(result)).to.not.include('last4');
    expect(textOf(result)).to.not.include('4242424242424242');
  });
});
