import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const advisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const expires = Date.parse('2026-11-24T00:00:00Z');
const patch = fileURLToPath(
  new URL('../../patches/picomatch+4.0.7.patch', import.meta.url),
);
const originalHash =
  '4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4';
const patchedHash =
  '052556469d86a30a898657c9dc7e730c9c0eb672eb715af14cb2bc46bdb8aeea';
const patchHash =
  '3b689463823f8c57917c8caa6d2a74875b0cab92bbe8bd628440b69bc7bf5d02';
const hash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

// Apply only to the exact upstream bytes, then verify every locked copy.
// Verification never repairs files: a missing or altered patch must fail audit.
export function patchPicomatch(root, apply = false) {
  assert.equal(hash(patch), patchHash, 'Unexpected picomatch patch bytes');
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith('node_modules/picomatch'),
  );
  assert(copies.length > 0, 'Expected a locked picomatch dependency');
  for (const [path, pkg] of copies) {
    assert.equal(
      pkg.version,
      '4.0.7',
      'Review the patch for the new picomatch version',
    );
    assert.equal(pkg.dev, true, 'The exception is development-only');
    assert.equal(
      JSON.parse(readFileSync(join(root, path, 'package.json'))).version,
      '4.0.7',
    );
    const parser = join(root, path, 'lib/parse.js');
    if (apply && hash(parser) === originalHash) {
      const result = spawnSync('git', ['apply', `--directory=${path}`, patch], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    }
    assert.equal(
      hash(parser),
      patchedHash,
      `Unverified picomatch parser: ${path}`,
    );
  }
  return lock;
}

export function checkAudit(report, root, now = new Date()) {
  const lock = patchPicomatch(root);
  assert(
    report && !report.error && report.auditReportVersion === 2,
    'Invalid npm audit report',
  );
  const vulnerabilities = report.vulnerabilities;
  assert(
    vulnerabilities &&
      typeof vulnerabilities === 'object' &&
      !Array.isArray(vulnerabilities),
  );
  const levels = ['info', 'low', 'moderate', 'high', 'critical'];
  for (const level of levels) {
    assert.equal(
      report.metadata?.vulnerabilities?.[level],
      Object.values(vulnerabilities).filter((v) => v.severity === level).length,
      'Inconsistent npm audit counts',
    );
  }
  assert.equal(
    report.metadata.vulnerabilities.total,
    Object.keys(vulnerabilities).length,
  );

  function causes(name, ancestors = []) {
    assert(!ancestors.includes(name), `Cyclic audit dependency: ${name}`);
    const vuln = vulnerabilities[name];
    assert(
      vuln && Array.isArray(vuln.via) && vuln.via.length > 0,
      `Missing audit causes: ${name}`,
    );
    return vuln.via.flatMap((via) => {
      if (typeof via === 'string') return causes(via, [...ancestors, name]);
      assert(via && levels.includes(via.severity), 'Unknown advisory severity');
      return via;
    });
  }

  for (const [name, vuln] of Object.entries(vulnerabilities)) {
    assert(
      vuln.name === name && levels.includes(vuln.severity),
      'Unknown audit finding',
    );
    const high = causes(name).filter(
      (via) => via.severity === 'high' || via.severity === 'critical',
    );
    if (
      vuln.severity !== 'high' &&
      vuln.severity !== 'critical' &&
      high.length === 0
    )
      continue;
    assert(vuln.severity !== 'critical', `Critical vulnerability: ${name}`);
    assert(
      Number.isFinite(+now) && +now < expires,
      'Picomatch audit exception expired on 2026-11-24',
    );
    assert(
      Array.isArray(vuln.nodes) && vuln.nodes.length > 0,
      'Missing affected installation paths',
    );
    assert(
      vuln.nodes.every((path) => lock.packages[path]?.dev === true),
      `Production exposure: ${name}`,
    );
    if (name === 'picomatch') {
      assert(
        vuln.nodes.every((path) => path.endsWith('node_modules/picomatch')),
        'Unexpected picomatch path',
      );
    }
    assert(
      high.length > 0 &&
        high.every(
          (via) =>
            via.url === advisory &&
            via.name === 'picomatch' &&
            via.dependency === 'picomatch' &&
            via.severity === 'high' &&
            via.range === '<=4.0.7',
        ),
      `Unexcepted vulnerability: ${name}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] === 'apply') {
      patchPicomatch(process.cwd(), true);
      console.log('Verified picomatch 4.0.7 patch');
    } else {
      assert.equal(
        process.argv[2],
        'audit',
        'Usage: picomatch-security.mjs apply|audit',
      );
      for (const production of [false, true]) {
        const result = spawnSync(
          'npm',
          [
            'audit',
            '--json',
            '--audit-level=high',
            '--include=prod',
            '--include=optional',
            '--include=peer',
            production ? '--omit=dev' : '--include=dev',
          ],
          {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
            shell: process.platform === 'win32',
          },
        );
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        assert(
          !result.error && (result.status === 0 || result.status === 1),
          'npm audit failed to run',
        );
        const report = JSON.parse(result.stdout);
        checkAudit(report, process.cwd());
        assert.equal(
          result.status,
          Number(
            report.metadata.vulnerabilities.high +
              report.metadata.vulnerabilities.critical >
              0,
          ),
          'Inconsistent npm audit exit status',
        );
        if (production)
          assert.equal(
            result.status,
            0,
            'Production high/critical findings cannot be excepted',
          );
      }
      const tests = spawnSync(
        process.execPath,
        [
          '--test',
          fileURLToPath(
            new URL('./picomatch-security.test.mjs', import.meta.url),
          ),
        ],
        { stdio: 'inherit', timeout: 30_000 },
      );
      assert.equal(tests.status, 0, 'Picomatch security regressions failed');
      console.log(
        'Audit passed with verified dev-only picomatch exception (expires 2026-11-24)',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
