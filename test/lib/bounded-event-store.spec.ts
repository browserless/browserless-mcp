import { expect } from 'chai';
import { BoundedEventStore } from '../../src/lib/bounded-event-store.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

function makeMessage(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method: 'test', params: {} } as JSONRPCMessage;
}

describe('BoundedEventStore', () => {
  it('stores and replays events for a stream', async () => {
    const store = new BoundedEventStore(100);

    const id1 = await store.storeEvent('stream-1', makeMessage(1));
    const id2 = await store.storeEvent('stream-1', makeMessage(2));
    const id3 = await store.storeEvent('stream-1', makeMessage(3));

    const replayed: Array<{ eventId: string; message: JSONRPCMessage }> = [];
    const streamId = await store.replayEventsAfter(id1, {
      send: async (eventId, message) => {
        replayed.push({ eventId, message });
      },
    });

    expect(streamId).to.equal('stream-1');
    expect(replayed).to.have.length(2);
    expect(replayed[0].eventId).to.equal(id2);
    expect(replayed[1].eventId).to.equal(id3);
  });

  it('returns empty string when replaying unknown event ID', async () => {
    const store = new BoundedEventStore(100);
    await store.storeEvent('stream-1', makeMessage(1));

    const streamId = await store.replayEventsAfter('nonexistent', {
      send: async () => {},
    });

    expect(streamId).to.equal('');
  });

  it('returns empty string when replaying empty event ID', async () => {
    const store = new BoundedEventStore(100);

    const streamId = await store.replayEventsAfter('', {
      send: async () => {},
    });

    expect(streamId).to.equal('');
  });

  it('only replays events from the same stream', async () => {
    const store = new BoundedEventStore(100);

    const id1 = await store.storeEvent('stream-a', makeMessage(1));
    await store.storeEvent('stream-b', makeMessage(2));
    const id3 = await store.storeEvent('stream-a', makeMessage(3));

    const replayed: string[] = [];
    await store.replayEventsAfter(id1, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });

    expect(replayed).to.have.length(1);
    expect(replayed[0]).to.equal(id3);
  });

  it('evicts oldest events when exceeding max capacity', async () => {
    const store = new BoundedEventStore(3);

    const id1 = await store.storeEvent('s', makeMessage(1));
    await store.storeEvent('s', makeMessage(2));
    await store.storeEvent('s', makeMessage(3));

    // Store a 4th event — should evict the 1st
    const id4 = await store.storeEvent('s', makeMessage(4));

    // id1 was evicted, so replay returns empty
    const streamId = await store.replayEventsAfter(id1, {
      send: async () => {},
    });
    expect(streamId).to.equal('');

    // id4 still exists
    const replayed: string[] = [];
    await store.replayEventsAfter(id4, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });
    expect(replayed).to.have.length(0); // id4 is last, nothing after it
  });

  it('keeps exactly maxEvents entries after eviction', async () => {
    const store = new BoundedEventStore(2);

    await store.storeEvent('s', makeMessage(1));
    const id2 = await store.storeEvent('s', makeMessage(2));
    const id3 = await store.storeEvent('s', makeMessage(3));

    // id2 and id3 should remain; replay after id2 should yield id3
    const replayed: string[] = [];
    await store.replayEventsAfter(id2, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });

    expect(replayed).to.have.length(1);
    expect(replayed[0]).to.equal(id3);
  });

  it('generates unique event IDs', async () => {
    const store = new BoundedEventStore(100);
    const ids = new Set<string>();

    for (let i = 0; i < 50; i++) {
      ids.add(await store.storeEvent('s', makeMessage(i)));
    }

    expect(ids.size).to.equal(50);
  });

  it('handles maxEvents of 1', async () => {
    const store = new BoundedEventStore(1);

    await store.storeEvent('s', makeMessage(1));
    const id2 = await store.storeEvent('s', makeMessage(2));

    // Only the latest event should exist
    const replayed: string[] = [];
    await store.replayEventsAfter(id2, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });
    expect(replayed).to.have.length(0);
  });
});
