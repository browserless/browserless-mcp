import { expect } from 'chai';
import { UserError } from 'fastmcp';
import sinon from 'sinon';

import { accountQuery } from '../../src/lib/account-api.js';

const config = {
  accountGraphqlUrl: 'https://accounts.example.com/graphql',
  requestTimeout: 100,
  maxRetries: 0,
};

describe('accountQuery', () => {
  afterEach(() => sinon.restore());

  it('sends the token only as the apiToken GraphQL variable', async () => {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(JSON.stringify({ data: { ok: true } })));

    const result = await accountQuery<{ ok: boolean }>(
      config,
      'secret-token',
      'query Test($apiToken: String) { test(apiToken: $apiToken) }',
      { limit: 5 },
    );
    expect(result).to.deep.equal({ ok: true });

    const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
    expect(url).to.equal(config.accountGraphqlUrl);
    expect(url).not.to.contain('secret-token');
    expect(JSON.stringify(init.headers)).not.to.contain('secret-token');
    expect(JSON.parse(init.body as string).variables).to.deep.equal({
      limit: 5,
      apiToken: 'secret-token',
    });
  });

  it('surfaces a GraphQL error as UserError without retrying', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          errors: [{ message: 'Plan does not allow logs.' }],
        }),
      ),
    );

    try {
      await accountQuery(
        { ...config, maxRetries: 3 },
        'secret-token',
        'query Test { test }',
      );
      expect.fail('expected UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.equal('Plan does not allow logs.');
    }
    expect(fetchStub.callCount).to.equal(1);
  });

  it('retries a network failure and then succeeds', async () => {
    const clock = sinon.useFakeTimers();
    sinon.stub(Math, 'random').returns(0);
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .onFirstCall()
      .rejects(new Error('socket closed'))
      .onSecondCall()
      .resolves(new Response(JSON.stringify({ data: { ok: true } })));

    const result = accountQuery<{ ok: boolean }>(
      { ...config, maxRetries: 1 },
      'secret-token',
      'query Test { test }',
    );
    await clock.tickAsync(1000);

    expect(await result).to.deep.equal({ ok: true });
    expect(fetchStub.callCount).to.equal(2);
  });

  it('turns a non-2xx response into a non-retried UserError', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({}), {
        status: 503,
        statusText: 'Unavailable',
      }),
    );

    try {
      await accountQuery(
        { ...config, maxRetries: 2 },
        'secret-token',
        'query Test { test }',
      );
      expect.fail('expected UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.contain('HTTP 503');
    }
    expect(fetchStub.callCount).to.equal(1);
  });

  it('aborts a hung request at requestTimeout', async () => {
    const clock = sinon.useFakeTimers();
    sinon.stub(globalThis, 'fetch').callsFake(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            );
          });
        }),
    );

    const result = accountQuery(config, 'secret-token', 'query Test { test }');
    await clock.tickAsync(config.requestTimeout);

    try {
      await result;
      expect.fail('expected timeout');
    } catch (error) {
      expect((error as Error).name).to.equal('AbortError');
      expect((error as Error).message).not.to.contain('secret-token');
    }
  });

  it('redacts the token if a server error message echoes it', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          errors: [{ message: 'Bad credential secret-token' }],
        }),
      ),
    );

    try {
      await accountQuery(config, 'secret-token', 'query Test { test }');
      expect.fail('expected UserError');
    } catch (error) {
      expect((error as Error).message).to.equal('Bad credential [REDACTED]');
      expect((error as Error).message).not.to.contain('secret-token');
    }
  });
});
