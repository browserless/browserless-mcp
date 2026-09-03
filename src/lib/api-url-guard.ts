import type { McpConfig } from '../@types/types.js';

type ApiUrlConfig = Pick<McpConfig, 'browserlessApiUrl' | 'allowedApiUrlHosts'>;

export class InvalidApiUrlError extends Error {}

export const allowedApiUrlHosts = (config: ApiUrlConfig): string[] => {
  let configuredHost: string | undefined;
  try {
    configuredHost = new URL(config.browserlessApiUrl).hostname;
  } catch {
    // The operator-configured URL is trusted and may use a custom scheme.
  }

  return [configuredHost, ...(config.allowedApiUrlHosts ?? [])]
    .filter((host): host is string => Boolean(host))
    .map((host) => host.toLowerCase());
};

export const assertAllowedApiUrl = (
  candidate: string,
  config: ApiUrlConfig,
): void => {
  try {
    if (candidate.length > 2048 || candidate.includes('\0')) throw new Error();
    const url = new URL(candidate);
    const host = url.hostname;
    const allowedHost =
      host === 'browserless.io' ||
      host.endsWith('.browserless.io') ||
      allowedApiUrlHosts(config).includes(host);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !allowedHost
    ) {
      throw new Error();
    }
  } catch {
    throw new InvalidApiUrlError('Invalid Browserless API URL override');
  }
};
