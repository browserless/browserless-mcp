#!/usr/bin/env node
// Credential-free structural checks. Runtime OAuth and client tests remain separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const clients = ['copilot', 'kiro'];
const manifestFields = [
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
];
for (const client of clients) {
  const manifest = json(`${client}/plugin.json`);
  assert.deepEqual(Object.keys(manifest).sort(), [...manifestFields].sort());
  assert.equal(
    manifest.$schema,
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  );
  assert.equal(manifest.name, 'browserless');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.license, 'SSPL-1.0');
  assert.equal(manifest.author.name, 'Browserless');
  assert(manifest.description.length > 0);
  assert(manifest.keywords.length > 0);
  const config = json(`${client}/mcp.json`);
  assert.deepEqual(config, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      browserless: {
        type: 'streamable-http',
        url: 'https://mcp.browserless.io/mcp',
      },
    },
  });
  const skill = read(`${client}/skills/browserless/SKILL.md`);
  assert.match(skill, /^---\nname: browserless\ndescription: .+\n---\n/);
  assert.match(skill, /\(references\/workflows\.md\)/);
  assert(
    read(`${client}/skills/browserless/references/workflows.md`).length > 0,
  );
  assert(!fs.existsSync(path.join(root, client, 'hooks')));
  assert(!fs.existsSync(path.join(root, client, '.claude-plugin')));
  assert(!fs.existsSync(path.join(root, client, '.mcp.json')));
  assert.equal(
    read(`${client}/LICENSE`),
    read('LICENSE')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n'),
  );
  assert(
    json('release-please-config.json').packages['.']['exclude-paths'].includes(
      client,
    ),
  );
}
for (const file of [
  'plugin.json',
  'mcp.json',
  'skills/browserless/SKILL.md',
  'skills/browserless/references/workflows.md',
  'LICENSE',
]) {
  assert.equal(
    read(`copilot/${file}`),
    read(`kiro/${file}`),
    `Portable payload drift: ${file}`,
  );
}
const catalog = json('.github/plugin/marketplace.json');
assert.equal(catalog.name, 'browserless');
assert.equal(catalog.plugins.length, 1);
assert.equal(catalog.plugins[0].source, './copilot');
for (const key of [
  'name',
  'description',
  'version',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]) {
  assert.deepEqual(
    catalog.plugins[0][key],
    json('copilot/plugin.json')[key],
    `Catalog metadata drift: ${key}`,
  );
}
assert(
  json('release-please-config.json').packages['.']['exclude-paths'].includes(
    '.github/plugin',
  ),
);
// Assert the existing tight npm allowlist stays intact. Do not broaden it to ship plugins.
assert.deepEqual(json('package.json').files, [
  'build/src/**/*.js',
  'build/src/**/*.d.ts',
  'build/src/**/*.md',
  'build/src/**/*.html',
  'bin/*',
  'scripts/*.mjs',
  'README.md',
]);
console.log(
  'PASS: manifests, secret-free MCP configuration, skill parity, licenses, release exclusions and npm boundaries',
);
