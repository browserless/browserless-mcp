import { expect } from 'chai';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import sinon from 'sinon';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSession,
  consumeDownload,
  downloadOwner,
  downloadUri,
  FILE_TRANSFER_MAX_BYTES,
  getDownload,
  storeDownload,
} from '../../src/lib/download-store.js';

const ownerA = 't:owner-a';
const ownerB = 't:owner-b';

describe('download-store', () => {
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.BROWSERLESS_DOWNLOAD_DIR;
    process.env.BROWSERLESS_DOWNLOAD_DIR = await mkdtemp(
      join(tmpdir(), 'mcp-store-'),
    );
  });

  afterEach(() => {
    sinon.restore();
    if (prev === undefined) delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    else process.env.BROWSERLESS_DOWNLOAD_DIR = prev;
  });

  it('derives a stable owner without exposing the token', () => {
    const token = 'raw-secret-token';
    expect(downloadOwner(token)).to.equal(downloadOwner(token));
    expect(downloadOwner(token)).to.not.equal(downloadOwner('other-token'));
    expect(downloadOwner(token)).to.not.include(token);
  });

  it('expires at the deadline even when the cleanup timer has not run', async () => {
    const now = sinon.stub(Date, 'now').returns(1000);
    const rec = await storeDownload(
      'deadline.txt',
      'text/plain',
      Buffer.from('x'),
      ownerA,
    );
    now.returns(900999);
    expect(getDownload(rec.id, ownerA)?.id).to.equal(rec.id);
    now.returns(901000);
    expect(getDownload(rec.id, ownerA)).to.be.undefined;
    expect(consumeDownload(rec.id, ownerA)).to.be.undefined;
    // A second record exercises consume without a prior expiry lookup.
    now.returns(1000);
    const second = await storeDownload(
      'consume.txt',
      'text/plain',
      Buffer.from('y'),
      ownerA,
    );
    now.returns(901000);
    expect(consumeDownload(second.id, ownerA)).to.be.undefined;
  });

  it('accepts the exact size ceiling and rejects one byte over without writing', async () => {
    const data = Buffer.alloc(FILE_TRANSFER_MAX_BYTES, 0x53);
    const rec = await storeDownload(
      'limit.bin',
      'application/octet-stream',
      data,
      ownerA,
    );
    expect(await readFile(rec.path)).to.deep.equal(data);
    const before = await readdir(process.env.BROWSERLESS_DOWNLOAD_DIR!);
    let rejected = false;
    try {
      await storeDownload(
        'over.bin',
        'application/octet-stream',
        Buffer.alloc(FILE_TRANSFER_MAX_BYTES + 1),
        ownerA,
      );
    } catch {
      rejected = true;
    }
    expect(rejected).to.be.true;
    expect(await readdir(process.env.BROWSERLESS_DOWNLOAD_DIR!)).to.deep.equal(
      before,
    );
  });

  it('rejects control characters in filenames before writing', async () => {
    for (const filename of ['bad\u0000.txt', 'bad\r\n.txt']) {
      let rejected = false;
      try {
        await storeDownload(filename, 'text/plain', Buffer.from('x'), ownerA);
      } catch {
        rejected = true;
      }
      expect(rejected).to.be.true;
    }
    expect(await readdir(process.env.BROWSERLESS_DOWNLOAD_DIR!)).to.deep.equal(
      [],
    );
  });

  it('generates opaque, unique ids', async () => {
    const records = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        storeDownload(`${i}.txt`, 'text/plain', Buffer.from('hi'), ownerA),
      ),
    );
    const ids = records.map(({ id }) => id);
    expect(new Set(ids)).to.have.length(100);
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).to.be.true;
    expect([...ids].sort()).to.not.deep.equal(ids);
  });

  it('resolves id, uri, and path only for the owner', async () => {
    const rec = await storeDownload(
      'a.txt',
      'text/plain',
      Buffer.from('hi'),
      ownerA,
    );
    expect(existsSync(rec.path)).to.be.true;
    expect(getDownload(rec.id, ownerA)?.id).to.equal(rec.id);
    expect(getDownload(downloadUri(rec.id), ownerA)?.id).to.equal(rec.id);
    expect(getDownload(rec.path, ownerA)?.id).to.equal(rec.id);
    expect(getDownload(rec.id, ownerB)).to.be.undefined;
    expect(getDownload(rec.path, ownerB)).to.be.undefined;
    expect(getDownload(rec.id, ownerA)?.id).to.equal(rec.id);
  });

  it('consumeDownload is single-use (second resolve misses)', async () => {
    const rec = await storeDownload(
      'b.txt',
      'text/plain',
      Buffer.from('hi'),
      ownerA,
    );
    expect(consumeDownload(downloadUri(rec.id), ownerB)).to.be.undefined;
    const first = consumeDownload(downloadUri(rec.id), ownerA);
    expect(first?.id).to.equal(rec.id);
    expect(consumeDownload(downloadUri(rec.id), ownerA)).to.be.undefined;
    expect(getDownload(rec.id, ownerA)).to.be.undefined;
  });

  it('clearSession drops files owned by the session', async () => {
    const mine = await storeDownload(
      'c.txt',
      'text/plain',
      Buffer.from('x'),
      ownerA,
      's1',
    );
    const other = await storeDownload(
      'd.txt',
      'text/plain',
      Buffer.from('y'),
      ownerA,
      's2',
    );
    clearSession('s1');
    expect(getDownload(mine.id, ownerA)).to.be.undefined;
    expect(getDownload(other.id, ownerA)?.id).to.equal(other.id);
  });
});
