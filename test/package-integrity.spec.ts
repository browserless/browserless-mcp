import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const distDir = () =>
  dirname(createRequire(import.meta.url).resolve('fastmcp'));
const distSources = () =>
  readdirSync(distDir())
    .filter((f) => /\.(cjs|js)$/.test(f))
    .map((f) => readFileSync(join(distDir(), f), 'utf8'));

// Guards the two packaging failures this postinstall has caused:
//   #181/1.13.0 — patch-package was a devDependency and patches/ was excluded
//     from `files`, so `--omit=dev` consumers hit "sh: patch-package: not found".
//   1.14.1 — patch-package, shipped as a transitive-dep postinstall, resolved
//     fastmcp under a cwd-relative node_modules and failed once `npm ci` hoisted
//     fastmcp elsewhere: "Patch file found for package fastmcp which is not
//     present at node_modules/fastmcp".
// The fix drops patch-package for a self-contained script that resolves the
// hoisted fastmcp via require.resolve and edits it idempotently.
describe('package integrity — installable by --omit=dev consumers', () => {
  it('runs the self-contained fastmcp patch script on postinstall', () => {
    expect(pkg.scripts?.postinstall).to.equal('node scripts/patch-fastmcp.mjs');
  });

  it('does not depend on patch-package', () => {
    // patch-package as a shipped transitive-dep postinstall is the root cause
    // of both prior failures; it must not return in either dependency set.
    expect(pkg.dependencies?.['patch-package'], 'not a runtime dep').to.equal(
      undefined,
    );
    expect(pkg.devDependencies?.['patch-package'], 'not a dev dep').to.equal(
      undefined,
    );
  });

  it('ships the postinstall script in the published package', () => {
    expect(pkg.files, 'files[] must publish scripts/*.mjs').to.include(
      'scripts/*.mjs',
    );
  });

  it('pins fastmcp to an exact version', () => {
    // The script edits fastmcp's built dist; an exact pin keeps that surface
    // predictable across installs.
    expect(
      pkg.dependencies?.fastmcp,
      'fastmcp must be pinned exactly',
    ).to.match(/^\d+\.\d+\.\d+$/);
  });

  it('has enabled tools.listChanged in the installed fastmcp', () => {
    const sources = distSources();
    expect(
      sources.some((c) =>
        c.includes('this.#capabilities.tools = { listChanged: true }'),
      ),
      'fastmcp dist should carry the listChanged capability',
    ).to.equal(true);
    expect(
      sources.some((c) => c.includes('this.#capabilities.tools = {};')),
      'no fastmcp dist file should retain the unpatched capability',
    ).to.equal(false);
  });

  it('re-runs idempotently without error', () => {
    const script = join(root, 'scripts', 'patch-fastmcp.mjs');
    expect(() =>
      execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    ).to.not.throw();
    expect(
      distSources().some((c) => c.includes('listChanged: true')),
      'capability must remain enabled after a second run',
    ).to.equal(true);
  });
});
