import type { McpConfig } from '../@types/types.js';

type ApiUrlConfig = Pick<McpConfig, 'browserlessApiUrl' | 'allowedApiUrlHosts'>;

export class InvalidApiUrlError extends Error {}

export const allowedApiUrlHosts = (config: ApiUrlConfig): string[] => {
  return (config.allowedApiUrlHosts ?? [])
    .filter((host): host is string => Boolean(host))
    .map((host) => host.toLowerCase());
};

export const assertAllowedApiUrl = (
  candidate: string,
  config: ApiUrlConfig,
): void => {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidApiUrlError('Invalid Browserless API URL override');
  }

  const host = url.hostname;
  const allowedHost =
    host === 'browserless.io' ||
    (host.length > '.browserless.io'.length &&
      host.endsWith('.browserless.io')) ||
    allowedApiUrlHosts(config).includes(host) ||
    url.origin === new URL(config.browserlessApiUrl).origin;

  if (
    candidate.length > 2048 ||
    candidate.includes('\0') ||
    // Parsed search/hash are empty for bare delimiters retained by raw sinks.
    candidate.includes('?') ||
    candidate.includes('#') ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowedHost
  ) {
    throw new InvalidApiUrlError('Invalid Browserless API URL override');
  }
};
