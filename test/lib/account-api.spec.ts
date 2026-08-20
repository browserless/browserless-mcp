import { expect } from 'chai';
import sinon from 'sinon';
import { UserError } from 'fastmcp';

import { accountQuery } from '../../src/lib/account-api.js';
import { DEFAULT_API_SERVER_URL } from '../../src/config.js';

const config = {
  apiServerUrl: 'https://account.example.com',
  requestTimeout: 30000,
  maxRetries: 0,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const bodyOf = (stub: sinon.SinonStub, call = 0) =>
  JSON.parse(stub.getCall(call).args[1].body as string);

describe('accountQuery', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('POSTs to the account API graphql endpoint', async () => {
    fetchStub.resolves(jsonResponse({ data: { ok: true } }));

    const data = await accountQuery(config, 'a-token', 'query { ok }');

    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.equal('https://account.example.com/graphql');
    expect(options.method).to.equal('POST');
    expect(options.headers['content-type']).to.equal('application/json');
    expect(data).to.deep.equal({ ok: true });
  });

  it('falls back to the default account host', async () => {
    fetchStub.resolves(jsonResponse({ data: {} }));

    await accountQuery(
      { requestTimeout: 1000, maxRetries: 0 },
      'a-token',
      'query { ok }',
    );

    expect(fetchStub.firstCall.args[0]).to.equal(
      `${DEFAULT_API_SERVER_URL}/graphql`,
    );
  });

  it('sends the token only in the apiToken variable', async () => {
    fetchStub.resolves(jsonResponse({ data: {} }));

    await accountQuery(config, 'secret-token', 'query { ok }', { limit: 5 });

    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.not.include('secret-token');
    expect(JSON.stringify(options.headers)).to.not.include('secret-token');

    const body = bodyOf(fetchStub);
    expect(body.variables.apiToken).to.equal('secret-token');
    expect(body.variables.limit).to.equal(5);
  });

  it('drops undefined variables instead of sending nulls', async () => {
    fetchStub.resolves(jsonResponse({ data: {} }));

    await accountQuery(config, 'a-token', 'query { ok }', {
      limit: undefined,
      search: 'x',
    });

    const body = bodyOf(fetchStub);
    expect(body.variables).to.not.have.property('limit');
    expect(body.variables.search).to.equal('x');
  });

  it('surfaces a GraphQL error as a UserError carrying the server message', async () => {
    fetchStub.resolves(
      jsonResponse({
        errors: [{ message: 'Request logs are not available for this plan.' }],
      }),
    );

    try {
      await accountQuery(config, 'a-token', 'query { ok }');
      expect.fail('Expected a UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.equal(
        'Request logs are not available for this plan.',
      );
    }
  });

  it('does not retry a GraphQL error', async () => {
    fetchStub.resolves(
      jsonResponse({ errors: [{ message: 'Invalid API token' }] }),
    );

    await accountQuery({ ...config, maxRetries: 3 }, 'a-token', 'query { ok }')
      .then(() => expect.fail('Expected a UserError'))
      .catch(() => undefined);

    expect(fetchStub.callCount).to.equal(1);
  });

  it('retries a network failure', async () => {
    fetchStub.onFirstCall().rejects(new TypeError('fetch failed'));
    fetchStub.onSecondCall().resolves(jsonResponse({ data: { ok: 1 } }));

    const data = await accountQuery(
      { ...config, maxRetries: 2 },
      'a-token',
      'query { ok }',
    );

    expect(fetchStub.callCount).to.equal(2);
    expect(data).to.deep.equal({ ok: 1 });
  });

  it('retries a transient 5xx response and then succeeds', async () => {
    fetchStub.onFirstCall().resolves(jsonResponse({}, 503));
    fetchStub.onSecondCall().resolves(jsonResponse({ data: { ok: 1 } }));

    const data = await accountQuery(
      { ...config, maxRetries: 1 },
      'a-token',
      'query { ok }',
    );

    expect(fetchStub.callCount).to.equal(2);
    expect(data).to.deep.equal({ ok: 1 });
  });

  it('cancels a transient 5xx response body before retrying', async () => {
    let cancelCount = 0;
    const body = new ReadableStream({
      cancel: () => {
        cancelCount += 1;
      },
    });
    fetchStub.onFirstCall().resolves(new Response(body, { status: 503 }));
    fetchStub.onSecondCall().resolves(jsonResponse({ data: { ok: 1 } }));

    await accountQuery({ ...config, maxRetries: 1 }, 'a-token', 'query { ok }');

    expect(cancelCount).to.equal(1);
  });

  it('retries an HTML gateway response before surfacing a safe UserError', async () => {
    fetchStub.resolves(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    try {
      await accountQuery(
        { ...config, maxRetries: 1 },
        'secret-token',
        'query { ok }',
      );
      expect.fail('Expected a UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.include('502');
      expect((error as Error).message).to.not.include('secret-token');
    }
    expect(fetchStub.callCount).to.equal(2);
  });

  it('reports a non-2xx response without leaking the token', async () => {
    fetchStub.resolves(jsonResponse({}, 502));

    try {
      await accountQuery(config, 'secret-token', 'query { ok }');
      expect.fail('Expected a UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.include('502');
      expect((error as Error).message).to.not.include('secret-token');
    }
  });

  it('rejects a 200 response that carries no data', async () => {
    fetchStub.resolves(jsonResponse({}));

    try {
      await accountQuery(config, 'a-token', 'query { ok }');
      expect.fail('Expected a UserError');
    } catch (error) {
      expect((error as Error).message).to.include('no data');
    }
  });
});
