import {
  SQSClient,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { AmplitudeEvent } from '../@types/types.js';

export class AmplitudeHelper {
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
    if (!this.enabled || !this.initialized || !this.sqsClient || !this.queueUrl) {
      return false;
    }

    const event: AmplitudeEvent = {
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
}
