import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const STANDALONE_STREAM_ID = '_GET_stream';
const SMALL_ENTRY_BYTES = 1024;

/**
 * A bounded in-memory EventStore that caps the number of stored events
 * to prevent unbounded memory growth. Evicts oldest entries when full.
 *
 * The default InMemoryEventStore from mcp-proxy never evicts events,
 * causing a steady memory leak in long-running servers.
 */
export class BoundedEventStore implements EventStore {
  private events = new Map<
    string,
    {
      message: JSONRPCMessage;
      streamId: string;
      storedAt: number;
      bytes: number;
      sessionId?: string;
    }
  >();
  private lastTimestamp = 0;
  private lastTimestampCounter = 0;
  private heldBytes = 0;

  constructor(
    private readonly maxEvents = 10_000,
    private readonly maxAgeMs = 10 * 60_000,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.events.size;
  }

  get storedBytes(): number {
    return this.heldBytes;
  }

  async storeEvent(
    streamId: string,
    message: JSONRPCMessage,
    sessionId?: string,
  ): Promise<string> {
    // Keep standalone cursors for reattachment without retaining keepalives.
    if (streamId === STANDALONE_STREAM_ID)
      return this.generateEventId(streamId);

    const now = Date.now();
    this.evictExpired(now);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.maxBytes) return '';

    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, {
      message,
      streamId,
      storedAt: now,
      bytes,
      sessionId,
    });
    this.heldBytes += bytes;

    while (this.events.size > this.maxEvents) {
      this.drop(this.events.keys().next().value as string);
    }
    if (this.heldBytes > this.maxBytes) {
      for (const [id, event] of this.events) {
        if (this.heldBytes <= this.maxBytes) break;
        if (event.bytes > SMALL_ENTRY_BYTES) this.drop(id);
      }
    }

    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    {
      send,
      sessionId,
    }: {
      send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
      sessionId?: string;
    },
  ): Promise<string> {
    this.evictExpired(Date.now());
    if (
      lastEventId &&
      this.getStreamIdFromEventId(lastEventId) === STANDALONE_STREAM_ID
    ) {
      return STANDALONE_STREAM_ID;
    }
    if (!lastEventId || !this.events.has(lastEventId)) {
      return '';
    }

    const context = this.events.get(lastEventId)!.sessionId;
    if (context !== undefined && context !== sessionId) return '';

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) {
      return '';
    }

    let foundLastEvent = false;
    // Snapshot to avoid absorbing events added concurrently during async send()
    const snapshot = [...this.events.entries()];
    for (const [eventId, event] of snapshot) {
      if (event.streamId !== streamId) continue;
      if (event.sessionId !== undefined && event.sessionId !== sessionId)
        continue;
      if (!foundLastEvent) {
        if (eventId === lastEventId) foundLastEvent = true;
        continue;
      }
      await send(eventId, event.message);
    }

    return streamId;
  }

  private drop(eventId: string): void {
    const event = this.events.get(eventId)!;
    this.heldBytes -= event.bytes;
    this.events.delete(eventId);
  }

  private evictExpired(now: number): void {
    for (const [id, event] of this.events) {
      if (now - event.storedAt < this.maxAgeMs) break;
      this.drop(id);
    }
  }

  private generateEventId(streamId: string): string {
    const now = Date.now();
    if (now === this.lastTimestamp) {
      this.lastTimestampCounter++;
    } else {
      this.lastTimestamp = now;
      this.lastTimestampCounter = 0;
    }
    const random = Math.random().toString(36).slice(2, 8);
    return `${streamId}_${now}_${this.lastTimestampCounter}_${random}`;
  }

  private getStreamIdFromEventId(eventId: string): string | undefined {
    // Event ID format: {streamId}_{timestamp}_{counter}_{random}
    // streamId itself may contain underscores, so take everything except the last 3 segments
    const parts = eventId.split('_');
    return parts.length >= 4 ? parts.slice(0, -3).join('_') : undefined;
  }
}
