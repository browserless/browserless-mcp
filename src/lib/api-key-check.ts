import { fullHash } from './account-resolver.js';
import { ResponseCache } from './cache.js';

const KNOWN_TTL_MS = 5 * 60_000;
const UNKNOWN_TTL_MS = 30_000;
const CHECK_TIMEOUT_MS = 3_000;
const MAX_ENTRIES = 10_000;

const checks = new ResponseCache(KNOWN_TTL_MS);

export class UnknownApiKeyError extends Error {
  constructor() {
    super('Invalid Browserless API key. Check the key and try again.');
    this.name = 'UnknownApiKeyError';
  }
}

const remember = (id: string, known: boolean): void => {
  if (checks.size < MAX_ENTRIES)
    checks.set(id, known, known ? KNOWN_TTL_MS : UNKNOWN_TTL_MS);
};

/**
 * Ask the Browserless API whether a plain key exists. Throws
 * `UnknownApiKeyError` only for a definitive unknown-key answer; every other
 * outcome (billing refusals, other statuses, redirects, timeouts) lets the key through.
 */
export const assertKnownApiKey = async (
  apiUrl: string,
  key: string,
): Promise<void> => {
  const id = fullHash(apiUrl + '\n' + key);
  const cached = checks.get<boolean>(id);
  if (cached === false) throw new UnknownApiKeyError();
  if (cached === true) return;

  let known: boolean;
  try {
    const response = await fetch(apiUrl.replace(/\/+$/, '') + '/active', {
      headers: { authorization: 'Bearer ' + key },
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) {
      // The API answers an unknown key with 401 "Invalid API key…"; other 401s
      // (credits, spend cap, plan) mean the key exists, so they pass.
      known = !(await response.text())
        .trimStart()
        .startsWith('Invalid API key');
    } else {
      await response.body?.cancel();
      if (response.status < 200 || response.status > 299) return;
      known = true;
    }
  } catch {
    return;
  }

  remember(id, known);
  if (!known) throw new UnknownApiKeyError();
};

export const clearApiKeyCheckCache = (): void => {
  checks.clear();
};
