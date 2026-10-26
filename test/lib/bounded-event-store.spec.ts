import { expect } from 'chai';
import { BoundedEventStore } from '../../src/lib/bounded-event-store.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

function makeMessage(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method: 'test', params: {} } as JSONRPCMessage;
}

describe('BoundedEventStore', () => {
  it('measures multibyte text against the payload budget', async () => {
    const store = new BoundedEventStore(10_000, 10 * 60_000, 2048);
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { text: '界'.repeat(700) },
    };
    expect(await store.storeEvent('request', message)).to.equal('');
    expect(store.storedBytes).to.equal(0);
  });

  it('bounds an hour of request history by age', async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const bounded = new BoundedEventStore();
      const countOnly = new BoundedEventStore(10_000, Infinity);
      for (let tick = 0; tick < 36_000; tick++) {
        now += 100;
        for (const store of [bounded, countOnly]) {
          for (let ping = 0; ping < 12; ping++)
            await store.storeEvent('_GET_stream', makeMessage(ping));
          if (tick % 100 < 23)
            await store.storeEvent('request', makeMessage(tick));
        }
      }
      expect(bounded.size).to.be.lessThan(2000);
      expect(countOnly.size).to.be.greaterThan(8000);
    } finally {
      Date.now = originalNow;
    }
  });

  it('expires request history at ten minutes on replay and write', async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const store = new BoundedEventStore();
      const first = await store.storeEvent('request', makeMessage(1));
      const second = await store.storeEvent('request', makeMessage(2));
      now += 10 * 60_000 - 1;
      const replayed: string[] = [];
      await store.replayEventsAfter(first, {
        send: async (id) => {
          replayed.push(id);
        },
      });
      expect(replayed).to.deep.equal([second]);
      now++;
      expect(
        await store.replayEventsAfter(first, { send: async () => {} }),
      ).to.equal('');
      expect(store.size).to.equal(0);
      expect(store.storedBytes).to.equal(0);
      const third = await store.storeEvent('request', makeMessage(3));
      now += 10 * 60_000;
      await store.storeEvent('request', makeMessage(4));
      expect(store.size).to.equal(1);
      expect(store.storedBytes).to.equal(JSON.stringify(makeMessage(4)).length);
      expect(
        await store.replayEventsAfter(third, { send: async () => {} }),
      ).to.equal('');
    } finally {
      Date.now = originalNow;
    }
  });

  it('bounds retained payloads while keeping small start markers', async () => {
    const store = new BoundedEventStore();
    const marker = await store.storeEvent('request-long', {} as JSONRPCMessage);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        await store.storeEvent(`request-${i}`, {
          jsonrpc: '2.0',
          id: i,
          result: { text: 'x'.repeat(5 * 1024 * 1024) },
        }),
      );
    }
    expect(store.storedBytes).to.be.at.most(64 * 1024 * 1024);
    expect(store.size).to.be.at.most(13);
    expect(
      await store.replayEventsAfter(ids[0], { send: async () => {} }),
    ).to.equal('');
    expect(
      await store.replayEventsAfter(ids[19], { send: async () => {} }),
    ).to.equal('request-19');
    const replayed: string[] = [];
    expect(
      await store.replayEventsAfter(marker, {
        send: async (id) => {
          replayed.push(id);
        },
      }),
    ).to.equal('request-long');
    expect(replayed).to.deep.equal([]);
  });

  it('does not retain a result larger than the byte budget', async () => {
    const store = new BoundedEventStore();
    expect(
      await store.storeEvent('request', {
        jsonrpc: '2.0',
        id: 1,
        result: { text: 'x'.repeat(70 * 1024 * 1024) },
      }),
    ).to.equal('');
    expect(store.size).to.equal(0);
    expect(store.storedBytes).to.equal(0);
  });

  it('issues standalone cursors without retaining their events', async () => {
    const store = new BoundedEventStore(100);
    const id = await store.storeEvent('_GET_stream', makeMessage(1));
    await store.storeEvent('_GET_stream', makeMessage(2));
    expect(store.size).to.equal(0);
    expect(store.storedBytes).to.equal(0);
    await store.storeEvent('request', makeMessage(3));
    expect(id).to.match(/^_GET_stream_/);
    for (const cursor of [id, '_GET_stream_1_0_zzzzzz']) {
      const replayed: JSONRPCMessage[] = [];
      expect(
        await store.replayEventsAfter(cursor, {
          send: async (_id, message) => {
            replayed.push(message);
          },
        }),
      ).to.equal('_GET_stream');
      expect(replayed).to.deep.equal([]);
    }
  });

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

  it('replays correctly when stream IDs contain underscores', async () => {
    const store = new BoundedEventStore(10);
    const id1 = await store.storeEvent('stream_a', makeMessage(1));
    const id2 = await store.storeEvent('stream_a', makeMessage(2));

    const replayed: string[] = [];
    const streamId = await store.replayEventsAfter(id1, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });

    expect(streamId).to.equal('stream_a');
    expect(replayed).to.deep.equal([id2]);
  });

  it('preserves insertion order when many events share a timestamp', async () => {
    const store = new BoundedEventStore(100);
    const originalNow = Date.now;
    Date.now = () => 1234567890;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await store.storeEvent('s', makeMessage(i)));
      }

      const replayed: number[] = [];
      await store.replayEventsAfter(ids[0], {
        send: async (_eventId, message) => {
          replayed.push((message as unknown as { id: number }).id);
        },
      });

      expect(replayed).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      Date.now = originalNow;
    }
  });
});
