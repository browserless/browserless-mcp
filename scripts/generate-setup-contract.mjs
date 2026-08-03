import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const args = process.argv.slice(2);
const mode =
  args.length === 0
    ? 'write'
    : args.length === 1 && args[0] === '--check'
      ? 'check'
      : null;
if (!mode) {
  console.error('Usage: node scripts/generate-setup-contract.mjs [--check]');
  process.exit(1);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const { createSetupContract } = await import(
  new URL('../build/src/setup-contract.js', import.meta.url)
);
const outputPath = resolve(root, 'setup/browserless-mcp-setup.json');
const prettierConfig = (await resolveConfig(outputPath)) ?? {};
const expected = await format(
  JSON.stringify(
    createSetupContract({
      name: pkg.name,
      engines: pkg.engines,
    }),
  ),
  { ...prettierConfig, parser: 'json' },
);

if (mode === 'check') {
  let actual;
  try {
    actual = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(
      'setup/browserless-mcp-setup.json is missing; restore the tracked file or run npm run generate:setup',
    );
    process.exitCode = 1;
  }
  if (actual !== undefined && actual !== expected) {
    console.error(
      'setup/browserless-mcp-setup.json is stale; run npm run generate:setup',
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(resolve(root, 'setup'), { recursive: true });
  await writeFile(outputPath, expected);
}
