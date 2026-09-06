import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../../src/@types/types.js';
import { downloadOwner, storeDownload } from '../../src/lib/download-store.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: '',
  supabaseServiceRoleKey: '',
} as McpConfig;

describe('download route', () => {
  const app = () => {
    const server = new FastMCP({ name: 'test', version: '1.0.0' });
    registerDownloadRoute(server, config);
    return server.getApp();
  };

  it('requires a token', async () => {
    expect((await app().request('/download/missing')).status).to.equal(401);
  });

  it('hides foreign records without consuming them', async () => {
    const record = await storeDownload(
      'private.txt',
      'text/plain',
      Buffer.from('owner bytes'),
      downloadOwner('owner-a'),
    );
    const route = app();
    const foreign = await route.request(`/download/${record.id}?token=owner-b`);
    const unknown = await route.request('/download/unknown?token=owner-b');

    expect(foreign.status).to.equal(404);
    expect(await foreign.text()).to.equal(await unknown.text());

    const owner = await route.request(`/download/${record.id}?token=owner-a`);
    expect(owner.status).to.equal(200);
    expect(await owner.text()).to.equal('owner bytes');
  });

  it('keeps successful downloads single-use', async () => {
    const record = await storeDownload(
      'once.txt',
      'text/plain',
      Buffer.from('once'),
      downloadOwner('owner-a'),
    );
    const route = app();
    expect(
      (await route.request(`/download/${record.id}?token=owner-a`)).status,
    ).to.equal(200);
    expect(
      (await route.request(`/download/${record.id}?token=owner-a`)).status,
    ).to.equal(404);
  });

  it('rejects malformed and foreign path handles without disclosure', async () => {
    const record = await storeDownload(
      'private.txt',
      'text/plain',
      Buffer.from('owner bytes'),
      downloadOwner('owner-a'),
    );
    const route = app();
    const ids = [
      '',
      'x'.repeat(4096),
      '../../etc/passwd',
      '%2e%2e%2f',
      '%00',
      '0'.repeat(32),
      encodeURIComponent(record.path),
    ];

    for (const id of ids) {
      const response = await route.request(`/download/${id}?token=owner-b`);
      expect(response.status).to.be.oneOf([400, 404]);
      const body = await response.text();
      expect(body).to.not.include(record.path);
      expect(body).to.not.include(record.filename);
    }
  });
});
