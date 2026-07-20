import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Guards the packaging failure from #181/1.13.0: `postinstall: patch-package`
// with patch-package only in devDependencies and patches/ excluded from `files`
// made the published package uninstallable for `npm ci --omit=dev` consumers
// (enterprise) — "sh: patch-package: not found".
describe('package integrity — installable by --omit=dev consumers', () => {
  it('runs patch-package on postinstall', () => {
    expect(pkg.scripts?.postinstall).to.equal('patch-package');
  });

  it('declares patch-package as a runtime dependency', () => {
    // postinstall runs on every install, including consumers' --omit=dev, so
    // patch-package must be a dependency, not a devDependency.
    expect(
      pkg.dependencies?.['patch-package'],
      'patch-package must be in dependencies',
    ).to.be.a('string');
    expect(
      pkg.devDependencies?.['patch-package'],
      'patch-package must not also be in devDependencies',
    ).to.equal(undefined);
  });

  it('ships the patches directory in the published package', () => {
    expect(
      (pkg.files || []).some((f: string) => f.includes('patches')),
      'files[] must include a patches glob',
    ).to.be.true;
  });

  it('pins fastmcp to the exact version each patch targets', () => {
    const patches = readdirSync(join(root, 'patches')).filter((f) =>
      f.endsWith('.patch'),
    );
    expect(patches.length, 'at least one patch expected').to.be.greaterThan(0);
    for (const p of patches) {
      const m = p.match(/^fastmcp\+(\d+\.\d+\.\d+)\.patch$/);
      if (!m) continue;
      // patch-package matches patches by the installed version in the filename;
      // a caret range could resolve to a version the patch can't apply to.
      expect(
        pkg.dependencies?.fastmcp,
        `fastmcp must be pinned exactly to ${m[1]} to match ${p}`,
      ).to.equal(m[1]);
    }
  });
});
