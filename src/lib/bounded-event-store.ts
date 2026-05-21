import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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
    { message: JSONRPCMessage; streamId: string }
  >();
  private lastTimestamp = 0;
  private lastTimestampCounter = 0;
  private readonly maxEvents: number;

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { message, streamId });

    // Evict oldest entries when over capacity
    if (this.events.size > this.maxEvents) {
      const keysToDelete = [...this.events.keys()].slice(
        0,
        this.events.size - this.maxEvents,
      );
      for (const key of keysToDelete) {
        this.events.delete(key);
      }
    }

    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    {
      send,
    }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return '';
    }

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) {
      return '';
    }

    let foundLastEvent = false;
    // Snapshot to avoid absorbing events added concurrently during async send()
    const snapshot = [...this.events.entries()];
    for (const [eventId, event] of snapshot) {
      if (event.streamId !== streamId) continue;
      if (!foundLastEvent) {
        if (eventId === lastEventId) foundLastEvent = true;
        continue;
      }
      await send(eventId, event.message);
    }

    return streamId;
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
