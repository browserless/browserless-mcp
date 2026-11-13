import assert from 'node:assert/strict';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function verifyAntigravityPlugin(root = repoRoot) {
  const pluginRoot = join(root, 'antigravity');
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const manifest = await json(join(pluginRoot, 'plugin.json'));
  for (const field of [
    'name',
    'displayName',
    'description',
    'version',
    'logo',
  ]) {
    assert.equal(typeof manifest[field], 'string', `${field} must be a string`);
    assert.ok(manifest[field].trim(), `${field} must not be empty`);
  }
  assert.equal(manifest.name, 'browserless');
  assert.equal(manifest.displayName, 'Browserless');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.license, 'SSPL-1.0');
  assert.equal(manifest.author.name, 'Browserless');
  assert.ok(manifest.suggestedPrompts?.length > 0);
  assert.ok(manifest.suggestedPrompts.length <= 3);
  const logoPath = resolve(pluginRoot, manifest.logo);
  const logoRelative = relative(pluginRoot, logoPath);
  assert.ok(
    !isAbsolute(logoRelative) &&
      logoRelative !== '..' &&
      !logoRelative.startsWith('../'),
    'logo must be inside the plugin',
  );
  assert.ok((await lstat(logoPath)).isFile(), 'logo must be bundled');
  assert.deepEqual(await json(join(pluginRoot, 'mcp_config.json')), {
    mcpServers: {
      browserless: {
        serverUrl: 'https://mcp.browserless.io/mcp',
        headers: { Authorization: 'Bearer ${BROWSERLESS_API_TOKEN}' },
        variables: [
          {
            name: 'BROWSERLESS_API_TOKEN',
            title: 'Browserless API token',
            description:
              'Enter your Browserless API token from your account dashboard. Browser operations use your account quota.',
            link: 'https://account.browserless.io/',
          },
        ],
      },
    },
  });
  assert.equal(
    (await readFile(join(pluginRoot, 'LICENSE'), 'utf8')).replace(
      /[ \t]+$/gm,
      '',
    ),
    (await readFile(join(root, 'LICENSE'), 'utf8')).replace(/[ \t]+$/gm, ''),
    'plugin license must match the repository',
  );
  const skill = await readFile(
    join(pluginRoot, 'skills/browserless/SKILL.md'),
    'utf8',
  );
  assert.match(skill, /^---\nname: browserless\ndescription: .+\n---\n/);
  assert.match(skill, /references\/workflows\.md/);
  assert.ok(
    (
      await readFile(
        join(pluginRoot, 'skills/browserless/references/workflows.md'),
        'utf8',
      )
    ).trim(),
  );
  assert.ok((await readFile(join(pluginRoot, 'README.md'), 'utf8')).trim());
  const release = await json(join(root, 'release-please-config.json'));
  assert.ok(
    release.packages['.']['exclude-paths'].includes('antigravity'),
    'plugin-only changes must not trigger an MCP release',
  );
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'plugin must not contain symlinks');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else assert.ok(entry.isFile(), 'plugin must contain regular files only');
    }
  };
  await visit(pluginRoot);
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const manifest = await verifyAntigravityPlugin();
  console.log(
    `Antigravity bundle invariants passed (${manifest.name} ${manifest.version})`,
  );
}
