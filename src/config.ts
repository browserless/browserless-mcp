export const DEFAULT_API_URL = 'https://production-sfo.browserless.io';

export interface BrowserlessSession extends Record<string, unknown> {
  token: string;
  apiUrl: string;
}

export interface McpConfig {
  browserlessToken?: string;
  browserlessApiUrl: string;
  transport: 'stdio' | 'httpStream';
  port: number;
  requestTimeout: number;
  maxRetries: number;
  cacheTtlMs: number;
  analyticsEnabled: boolean;
  sqsQueueUrl?: string;
  sqsRegion: string;
}

export function getConfig(): McpConfig {
  return {
    browserlessToken: process.env.BROWSERLESS_TOKEN,
    browserlessApiUrl:
      process.env.BROWSERLESS_API_URL ?? DEFAULT_API_URL,
    transport:
      (process.env.TRANSPORT as 'stdio' | 'httpStream') ?? 'stdio',
    port: parseInt(process.env.PORT ?? '8080', 10),
    requestTimeout: parseInt(
      process.env.BROWSERLESS_TIMEOUT ?? '30000',
      10,
    ),
    maxRetries: parseInt(process.env.BROWSERLESS_MAX_RETRIES ?? '3', 10),
    cacheTtlMs: parseInt(
      process.env.BROWSERLESS_CACHE_TTL ?? '60000',
      10,
    ),
    analyticsEnabled: process.env.ANALYTICS_ENABLED === 'true',
    sqsQueueUrl: process.env.SQS_QUEUE_URL,
    sqsRegion: process.env.SQS_REGION ?? 'us-west-2',
  };
}
