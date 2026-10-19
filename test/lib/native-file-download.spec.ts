import { expect } from 'chai';
import sinon from 'sinon';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { downloadNativeFile } from '../../src/lib/native-file-download.js';
import { FILE_TRANSFER_MAX_BYTES as CAP } from '../../src/lib/download-store.js';

describe('downloadNativeFile', () => {
  const url = 'https://files.example/file?signature=secret';
  let request: any;
  let response: any;
  let lookup: sinon.SinonStub;
  let network: sinon.SinonStub;
  let status: number;
  let length: string | undefined;
  let body: Buffer[];
  let stall: boolean;

  beforeEach(() => {
    status = 200;
    length = undefined;
    body = [Buffer.from('file')];
    stall = false;
    request = new EventEmitter();
    request.destroy = sinon.spy();
    response = new PassThrough();
    lookup = sinon.stub(dns, 'lookup').callsFake(((
      _host: any,
      _opts: any,
      cb: any,
    ) => {
      cb(null, [{ address: '8.8.8.8', family: 4 }]);
    }) as any);
    network = sinon.stub(https, 'request').callsFake(((
      options: any,
      cb: any,
    ) => {
      request.end = () =>
        options.lookup(options.hostname, {}, (error: any, address: any) => {
          if (error) return request.emit('error', error);
          expect(address).to.equal('8.8.8.8');
          queueMicrotask(() => {
            response.statusCode = status;
            response.headers =
              length === undefined ? {} : { 'content-length': length };
            cb(response);
            if (!stall) {
              for (const chunk of body) response.write(chunk);
              response.end();
            }
          });
        });
      return request;
    }) as any);
  });
  afterEach(() => sinon.restore());

  async function rejected(promise: Promise<Buffer>, reason?: string) {
    try {
      await promise;
      expect.fail('expected rejection');
    } catch (error) {
      expect((error as Error).message).to.match(/^Native file download /);
      expect((error as Error).message).not.to.include('signature=secret');
      if (reason) expect((error as Error).message).to.include(reason);
    }
  }
  const download = () => downloadNativeFile(url, ['files.example']);

  it('denies an empty allowlist before DNS or network', async () => {
    await rejected(downloadNativeFile(url), 'disabled');
    expect(lookup.called).to.equal(false);
    expect(network.called).to.equal(false);
  });
  for (const invalid of [
    'http://files.example/a',
    'https://u:p@files.example/a',
    'https://files.example:444/a',
    'https://files.example.evil/a',
    'https://evil/a',
    'invalid',
  ]) {
    it(`rejects URL attack ${invalid}`, async () => {
      await rejected(downloadNativeFile(invalid, ['files.example']));
      expect(network.called).to.equal(false);
    });
  }
  it('pins a single DNS result while retaining TLS hostname and sends no credentials', async () => {
    expect((await download()).toString()).to.equal('file');
    expect(lookup.callCount).to.equal(1);
    const options = network.firstCall.args[0];
    expect(options.hostname).to.equal('files.example');
    expect(options.servername).to.equal('files.example');
    expect(options.agent).to.equal(false);
    expect(options.auth).to.equal(undefined);
    expect(options.headers).to.equal(undefined);
    expect(options.path).to.equal('/file?signature=secret');
  });
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
  ]) {
    it(`rejects nonpublic DNS record ${address}, even mixed with public records`, async () => {
      lookup.callsFake(((_host: any, _opts: any, cb: any) =>
        cb(null, [
          { address: '8.8.8.8', family: 4 },
          { address, family: address.includes(':') ? 6 : 4 },
        ])) as any);
      await rejected(download());
      expect(request.destroy.called).to.equal(true);
    });
  }
  for (const code of [301, 302, 307, 308, 403, 404, 500]) {
    it(`rejects HTTP ${code} without following destinations`, async () => {
      status = code;
      await rejected(download(), code < 400 ? 'redirect' : `HTTP ${code}`);
      expect(network.callCount).to.equal(1);
      expect(response.destroyed).to.equal(true);
    });
  }
  for (const declared of [undefined, String(CAP), '1']) {
    it(`accepts exactly the cap with length ${declared}`, async () => {
      length = declared;
      body = [Buffer.alloc(CAP)];
      expect((await download()).length).to.equal(CAP);
    });
    it(`rejects cap plus one with length ${declared}`, async () => {
      length = declared;
      body = [Buffer.alloc(CAP), Buffer.alloc(1)];
      await rejected(download(), 'size limit');
      expect(response.destroyed).to.equal(true);
    });
  }
  it('rejects oversized declared length before consuming the body', async () => {
    length = String(CAP + 1);
    stall = true;
    await rejected(download());
    expect(response.destroyed).to.equal(true);
  });
  it('rejects a rebinding answer without ever resolving twice', async () => {
    lookup
      .onSecondCall()
      .callsFake(((_host: any, _opts: any, cb: any) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }])) as any);
    expect((await download()).toString()).to.equal('file');
    expect(lookup.callCount).to.equal(1);
    expect(network.firstCall.args[0].autoSelectFamily).to.equal(false);
  });
  it('accepts public IPv6 and pins it to the TLS lookup callback', async () => {
    lookup.callsFake(((_host: any, _opts: any, cb: any) =>
      cb(null, [{ address: '2606:4700:4700::1111', family: 6 }])) as any);
    network.callsFake(((options: any, cb: any) => {
      request.end = () =>
        options.lookup(
          options.hostname,
          {},
          (error: any, address: any, family: any) => {
            expect(error).to.equal(null);
            expect(address).to.equal('2606:4700:4700::1111');
            expect(family).to.equal(6);
            response.statusCode = 200;
            response.headers = {};
            cb(response);
            response.end('ipv6');
          },
        );
      return request;
    }) as any);
    expect((await download()).toString()).to.equal('ipv6');
  });
  it('rejects DNS failures without exposing their details', async () => {
    lookup.callsFake(((_host: any, _opts: any, cb: any) =>
      cb(new Error(url))) as any);
    await rejected(download());
  });
  it('rejects a prematurely closed body', async () => {
    stall = true;
    const result = rejected(download());
    await Promise.resolve();
    response.destroy();
    await result;
  });
  for (const phase of ['DNS', 'headers', 'body']) {
    it(`enforces a total 30 second deadline during ${phase}`, async () => {
      const clock = sinon.useFakeTimers();
      if (phase === 'DNS') lookup.callsFake((() => {}) as any);
      if (phase === 'headers') request.end = () => {};
      if (phase === 'headers') network.callsFake((() => request) as any);
      stall = true;
      const result = rejected(download(), 'timed out');
      await clock.tickAsync(30000);
      await result;
      expect(request.destroy.called).to.equal(true);
    });
  }
  it('sanitizes interrupted streams and destroys the request', async () => {
    stall = true;
    const result = rejected(download());
    await Promise.resolve();
    response.destroy(new Error(url));
    await result;
    expect(request.destroy.called).to.equal(true);
  });
});
