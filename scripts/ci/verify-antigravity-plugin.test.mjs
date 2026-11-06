import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyAntigravityPlugin } from './verify-antigravity-plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-plugin-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const item of ['antigravity', 'LICENSE', 'release-please-config.json']) {
    await cp(join(root, item), join(dir, item), { recursive: true });
  }
  return dir;
};
const mutate = async (root, path, edit) => {
  const filename = join(root, path);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  edit(value);
  await writeFile(filename, JSON.stringify(value));
};

test('current bundle is self-contained and release-isolated', async () => {
  await verifyAntigravityPlugin(root);
});
test('rejects a logo outside the bundle', async (t) => {
  const dir = await fixture(t);
  await mutate(dir, 'antigravity/plugin.json', (m) => (m.logo = '../LICENSE'));
  await assert.rejects(verifyAntigravityPlugin(dir), /logo must be inside/);
});
test('rejects legacy remote URL fields', async (t) => {
  const dir = await fixture(t);
  await mutate(dir, 'antigravity/mcp_config.json', (m) => {
    m.mcpServers.browserless.url = m.mcpServers.browserless.serverUrl;
    delete m.mcpServers.browserless.serverUrl;
  });
  await assert.rejects(verifyAntigravityPlugin(dir));
});
test('rejects literal credentials in the connection', async (t) => {
  const dir = await fixture(t);
  await mutate(dir, 'antigravity/mcp_config.json', (m) => {
    m.mcpServers.browserless.headers = { Authorization: 'Bearer PLACEHOLDER' };
  });
  await assert.rejects(verifyAntigravityPlugin(dir));
});
test('rejects missing release exclusion', async (t) => {
  const dir = await fixture(t);
  await mutate(dir, 'release-please-config.json', (m) => {
    m.packages['.']['exclude-paths'] = ['hermes'];
  });
  await assert.rejects(verifyAntigravityPlugin(dir), /must not trigger/);
});
test('rejects references to files not bundled with the skill', async (t) => {
  const dir = await fixture(t);
  await rm(join(dir, 'antigravity/skills/browserless/references/workflows.md'));
  await assert.rejects(verifyAntigravityPlugin(dir), /ENOENT/);
});
test('rejects symlinked sibling content', async (t) => {
  const dir = await fixture(t);
  await symlink('../LICENSE', join(dir, 'antigravity/linked-license'));
  await assert.rejects(
    verifyAntigravityPlugin(dir),
    /must not contain symlinks/,
  );
});
