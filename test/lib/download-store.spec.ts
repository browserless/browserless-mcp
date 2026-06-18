import { expect } from 'chai';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSession,
  consumeDownload,
  downloadUri,
  getDownload,
  storeDownload,
} from '../../src/lib/download-store.js';

describe('download-store', () => {
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.BROWSERLESS_DOWNLOAD_DIR;
    process.env.BROWSERLESS_DOWNLOAD_DIR = await mkdtemp(
      join(tmpdir(), 'mcp-store-'),
    );
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    else process.env.BROWSERLESS_DOWNLOAD_DIR = prev;
  });

  it('stores bytes and resolves by id, uri, and path', async () => {
    const rec = await storeDownload('a.txt', 'text/plain', Buffer.from('hi'));
    expect(existsSync(rec.path)).to.be.true;
    expect(getDownload(rec.id)?.id).to.equal(rec.id);
    expect(getDownload(downloadUri(rec.id))?.id).to.equal(rec.id);
    expect(getDownload(rec.path)?.id).to.equal(rec.id);
  });

  it('consumeDownload is single-use (second resolve misses)', async () => {
    const rec = await storeDownload('b.txt', 'text/plain', Buffer.from('hi'));
    const first = consumeDownload(downloadUri(rec.id));
    expect(first?.id).to.equal(rec.id);
    expect(consumeDownload(downloadUri(rec.id))).to.be.undefined;
    expect(getDownload(rec.id)).to.be.undefined;
  });

  it('clearSession drops files owned by the session', async () => {
    const mine = await storeDownload('c.txt', 'text/plain', Buffer.from('x'), 's1');
    const other = await storeDownload('d.txt', 'text/plain', Buffer.from('y'), 's2');
    clearSession('s1');
    expect(getDownload(mine.id)).to.be.undefined;
    expect(getDownload(other.id)?.id).to.equal(other.id);
  });
});
