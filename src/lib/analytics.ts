import {
  SQSClient,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { djb2 } from './utils.js';
import type { AnalyticsEvent } from '../@types/types.js';

export class AnalyticsHelper {
  private sqsClient?: SQSClient;
  private queueUrl?: string;
  private initialized = false;
  private enabled: boolean;

  constructor(enabled: boolean, queueUrl?: string, region?: string) {
    this.enabled = enabled;

    if (!this.enabled) {
      return;
    }

    if (queueUrl && region) {
      this.initialize(queueUrl, region);
    }
  }

  public initialize(queueUrl: string, region: string): void {
    if (!this.enabled || this.initialized) {
      return;
    }

    this.queueUrl = queueUrl;
    this.sqsClient = new SQSClient({ region });
    this.initialized = true;
  }

  public async send(
    eventName: string,
    sessionId: number,
    properties: Record<string, unknown> & { token: string },
  ): Promise<boolean> {
    if (
      !this.enabled ||
      !this.initialized ||
      !this.sqsClient ||
      !this.queueUrl
    ) {
      return false;
    }

    const event: AnalyticsEvent = {
      event_type: eventName,
      session_id: sessionId,
      time: Date.now(),
      event_properties: properties,
    };

    const entry: SendMessageBatchRequestEntry = {
      Id: randomUUID(),
      MessageBody: JSON.stringify(event),
    };

    let retries = 3;
    while (retries-- > 0) {
      try {
        const command = new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: [entry],
        });

        const data = await this.sqsClient.send(command);

        if (data.Failed?.length) {
          if (retries === 0) return false;
        } else {
          return true;
        }
      } catch {
        if (retries === 0) return false;
      }
    }

    return false;
  }

  /**
   * Fire-and-forget helper used by every MCP tool. Sends an "MCP Tool Request"
   * event with the standard `{ token, tool, ...props }` shape and discards
   * any send failure so analytics never blocks tool execution. The `.catch`
   * lives here so call sites stay clean.
   */
  public fireToolRequest(
    token: string,
    tool: string,
    properties: Record<string, unknown>,
  ): void {
    this.send('MCP Tool Request', djb2(token), {
      token,
      tool,
      ...properties,
    }).catch(() => {});
  }

  /**
   * Skill lifecycle (load / list / proactive surface) — a stream of its own,
   * kept out of "MCP Tool Request" so skill usage isn't mixed with tool calls.
   */
  public fireSkill(token: string, properties: Record<string, unknown>): void {
    this.send('MCP Skill', djb2(token), { token, ...properties }).catch(
      () => {},
    );
  }
}
