import sinon from 'sinon';
import { clearApiKeyCheckCache } from '../../src/lib/api-key-check.js';

const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

export const isApiKeyCheck = (input: Parameters<typeof fetch>[0]): boolean => {
  try {
    return new URL(requestUrl(input)).pathname.endsWith('/active');
  } catch {
    return false;
  }
};

const keyOf = (init?: RequestInit): string =>
  new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ??
  '';

/**
 * Answer API key checks (`GET …/active`) without touching the network and pass
 * every other request to the real `fetch`. A numeric 401 uses the API's
 * unknown-key wording.
 */
export const stubApiKeyCheck = (
  answer: number | ((key: string) => Response | Promise<Response>) = 204,
): sinon.SinonStub => {
  clearApiKeyCheckCache();
  const realFetch = globalThis.fetch;
  const stub = sinon.stub(globalThis, 'fetch');
  stub.callsFake(async (input, init) => {
    if (!isApiKeyCheck(input)) return realFetch(input, init);
    if (typeof answer === 'function') return answer(keyOf(init));
    return new Response(
      answer === 401
        ? 'Invalid API key. Please check your API key and try again. (requestId: test)'
        : null,
      { status: answer },
    );
  });
  return stub;
};
