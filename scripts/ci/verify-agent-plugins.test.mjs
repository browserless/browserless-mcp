import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
function check(mutate) {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browserless-plugin-test-'),
  );
  try {
    for (const file of [
      'copilot',
      'kiro',
      'LICENSE',
      'package.json',
      'release-please-config.json',
      '.github/plugin',
      'scripts/ci/verify-agent-plugins.mjs',
    ]) {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.cpSync(path.join(root, file), path.join(tmp, file), {
        recursive: true,
      });
    }
    mutate?.(tmp);
    return spawnSync(
      process.execPath,
      ['scripts/ci/verify-agent-plugins.mjs'],
      { cwd: tmp, encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function edit(root, file, mutate) {
  const target = path.join(root, file);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutate(data);
  fs.writeFileSync(target, JSON.stringify(data));
}
test('accepts portable payload and matching catalog', () =>
  assert.equal(check().status, 0));
test('rejects token placeholder in remote configuration', () => {
  const result = check((r) =>
    edit(r, 'copilot/mcp.json', (c) => {
      c.mcpServers.browserless.headers = {
        Authorization: 'Bearer ${BROWSERLESS_TOKEN}',
      };
    }),
  );
  assert.notEqual(result.status, 0);
});
test('rejects copied skill drift', () => {
  const result = check((r) =>
    fs.appendFileSync(
      path.join(r, 'kiro/skills/browserless/SKILL.md'),
      '\nUnexpected drift\n',
    ),
  );
  assert.notEqual(result.status, 0);
});
test('rejects missing release exclusion', () => {
  const result = check((r) =>
    edit(r, 'release-please-config.json', (c) => {
      c.packages['.']['exclude-paths'] = ['hermes'];
    }),
  );
  assert.notEqual(result.status, 0);
});
test('rejects npm package leakage', () => {
  const result = check((r) =>
    edit(r, 'package.json', (p) => p.files.push('copilot/**')),
  );
  assert.notEqual(result.status, 0);
});
test('rejects marketplace version drift', () => {
  const result = check((r) =>
    edit(r, '.github/plugin/marketplace.json', (c) => {
      c.plugins[0].version = '99.0.0';
    }),
  );
  assert.notEqual(result.status, 0);
});

test('rejects a missing bundled skill reference', () => {
  const result = check((r) =>
    fs.unlinkSync(
      path.join(r, 'copilot/skills/browserless/references/workflows.md'),
    ),
  );
  assert.notEqual(result.status, 0);
});
test('rejects legacy transport in a portable MCP manifest', () => {
  const result = check((r) =>
    edit(r, 'kiro/mcp.json', (c) => {
      c.mcpServers.browserless.type = 'http';
    }),
  );
  assert.notEqual(result.status, 0);
});
