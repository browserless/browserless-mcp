import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../../src/@types/types.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';
import { registerUploadRoute } from '../../src/resources/upload-route.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: '',
  supabaseServiceRoleKey: '',
} as McpConfig;

describe('upload route', () => {
  const app = () => {
    const server = new FastMCP({ name: 'test', version: '1.0.0' });
    registerUploadRoute(server, config);
    registerDownloadRoute(server, config);
    return server.getApp();
  };

  const upload = (
    route: ReturnType<FastMCP['getApp']>,
    data: string | ArrayBuffer,
  ) => {
    const body = new FormData();
    body.set('file', new File([data], 'fixture.bin'));
    return route.request('/upload?token=owner-a', { method: 'POST', body });
  };

  it('requires a token', async () => {
    const body = new FormData();
    body.set('file', new File(['data'], 'fixture.txt'));
    expect(
      (await app().request('/upload', { method: 'POST', body })).status,
    ).to.equal(401);
  });

  it('returns the existing shape and owner-scopes the handle', async () => {
    const route = app();
    const response = await upload(route, 'upload bytes');
    expect(response.status).to.equal(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).to.deep.equal(
      ['ok', 'handle', 'filename', 'mimeType', 'size'].sort(),
    );
    const id = (json.handle as string).replace('browserless-download://', '');
    expect(
      (await route.request(`/download/${id}?token=owner-b`)).status,
    ).to.equal(404);
    const owner = await route.request(`/download/${id}?token=owner-a`);
    expect(owner.status).to.equal(200);
    expect(await owner.text()).to.equal('upload bytes');
  });

  it('rejects files over 50 MiB', async () => {
    const response = await upload(app(), new ArrayBuffer(51 * 1024 * 1024));
    expect(response.status).to.equal(413);
  });

  it('handles missing and empty files without a server error', async () => {
    const route = app();
    const missing = await route.request('/upload?token=owner-a', {
      method: 'POST',
      body: new FormData(),
    });
    expect(missing.status).to.equal(400);

    const empty = new FormData();
    empty.set('file', new File([], 'empty.txt'));
    const response = await route.request('/upload?token=owner-a', {
      method: 'POST',
      body: empty,
    });
    expect(response.status).to.not.equal(500);
  });
});
