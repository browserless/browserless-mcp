import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

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
      version: pkg.version,
      engines: pkg.engines,
    }),
  ),
  { ...prettierConfig, parser: 'json' },
);

if (process.argv.includes('--check')) {
  const actual = await readFile(outputPath, 'utf8').catch(() => '');
  if (actual !== expected) {
    console.error(
      'setup/browserless-mcp-setup.json is stale; run npm run generate:setup',
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(resolve(root, 'setup'), { recursive: true });
  await writeFile(outputPath, expected);
}
