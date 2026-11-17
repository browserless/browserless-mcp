import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { patchPicomatch, checkAudit } from './picomatch-security.mjs';

const require = createRequire(import.meta.url);

test('repeated wildcard extglobs reject adversarial non-matches without backtracking', () => {
  for (const pattern of ['+(*a)', '*(a*)', '*(a*|b)', '+(a[ab]*)']) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `console.log(require('picomatch').isMatch('a'.repeat(80) + '!', process.argv[1]))`,
        `${pattern}b`,
      ],
      { encoding: 'utf8', timeout: 1500 },
    );
    assert.equal(
      result.status,
      0,
      `${pattern}: ${result.error || result.stderr}`,
    );
    assert.equal(result.stdout.trim(), 'false', pattern);
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'picomatch-security-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync('node_modules/picomatch', join(root, 'node_modules/picomatch'), {
    recursive: true,
  });
  cpSync('package-lock.json', join(root, 'package-lock.json'));
  return root;
}

function audit() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      picomatch: {
        name: 'picomatch',
        severity: 'high',
        nodes: ['node_modules/picomatch'],
        via: [
          {
            name: 'picomatch',
            dependency: 'picomatch',
            severity: 'high',
            url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
            range: '<=4.0.7',
          },
        ],
      },
      'lint-staged': {
        name: 'lint-staged',
        severity: 'high',
        nodes: ['node_modules/lint-staged'],
        via: ['picomatch'],
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 2,
        critical: 0,
        total: 2,
      },
    },
  };
}

const beforeExpiry = new Date('2026-11-23T23:59:59Z');

test('audit exception accepts only the verified advisory and its inherited findings before expiry', (t) => {
  const root = fixture(t);
  assert.doesNotThrow(() => checkAudit(audit(), root, beforeExpiry));
  const changedAdvisory = audit();
  changedAdvisory.vulnerabilities.picomatch.via[0].url =
    'https://github.com/advisories/GHSA-other';
  assert.throws(() => checkAudit(changedAdvisory, root, beforeExpiry));
  const additionalAdvisory = audit();
  additionalAdvisory.vulnerabilities['lint-staged'].via.push({
    severity: 'high',
    url: 'https://github.com/advisories/GHSA-other',
  });
  assert.throws(() => checkAudit(additionalAdvisory, root, beforeExpiry));
  const critical = audit();
  critical.vulnerabilities.picomatch.severity = 'critical';
  critical.vulnerabilities.picomatch.via[0].severity = 'critical';
  critical.metadata.vulnerabilities.high--;
  critical.metadata.vulnerabilities.critical++;
  assert.throws(() => checkAudit(critical, root, beforeExpiry));
  assert.throws(() =>
    checkAudit(audit(), root, new Date('2026-11-24T00:00:00Z')),
  );
});

test('missing, unpatched, modified, unexpected-version and production copies cannot obtain an exception', (t) => {
  for (const mutation of [
    'missing',
    'unpatched',
    'modified',
    'version',
    'production',
  ]) {
    const root = fixture(t);
    const parser = join(root, 'node_modules/picomatch/lib/parse.js');
    if (mutation === 'missing') rmSync(parser);
    if (mutation === 'modified')
      writeFileSync(parser, readFileSync(parser, 'utf8') + '\n// drift\n');
    if (mutation === 'unpatched') {
      const undo = spawnSync(
        'git',
        [
          'apply',
          '--reverse',
          '--directory=node_modules/picomatch',
          join(process.cwd(), 'patches/picomatch+4.0.7.patch'),
        ],
        { cwd: root },
      );
      assert.equal(undo.status, 0, undo.stderr?.toString());
    }
    if (mutation === 'version' || mutation === 'production') {
      const lockPath = join(root, 'package-lock.json');
      const lock = JSON.parse(readFileSync(lockPath));
      if (mutation === 'version')
        lock.packages['node_modules/picomatch'].version = '4.0.6';
      else delete lock.packages['node_modules/picomatch'].dev;
      writeFileSync(lockPath, JSON.stringify(lock));
    }
    assert.throws(() => checkAudit(audit(), root, beforeExpiry), mutation);
    if (mutation === 'unpatched') {
      patchPicomatch(root, true);
      patchPicomatch(root, true);
      assert.doesNotThrow(() => checkAudit(audit(), root, beforeExpiry));
    } else {
      assert.throws(() => patchPicomatch(root, true), mutation);
    }
  }
});

test('malformed audits, missing graph edges, cycles and unmatched installed paths fail closed', (t) => {
  const root = fixture(t);
  for (const broken of [null, {}, { error: { code: 'EAUDIT' } }]) {
    assert.throws(() => checkAudit(broken, root, beforeExpiry));
  }
  for (const mutate of [
    (report) => {
      report.vulnerabilities['lint-staged'].via = ['missing'];
    },
    (report) => {
      report.vulnerabilities['lint-staged'].via = ['lint-staged'];
    },
    (report) => {
      report.vulnerabilities.picomatch.nodes = [
        'node_modules/other/node_modules/picomatch',
      ];
    },
    (report) => {
      report.vulnerabilities.picomatch.via = [];
    },
    (report) => {
      report.metadata.vulnerabilities.high = 0;
    },
    (report) => {
      report.vulnerabilities.picomatch.severity = 'unknown';
    },
  ]) {
    const report = audit();
    mutate(report);
    assert.throws(() => checkAudit(report, root, beforeExpiry));
  }
});

test('the install hook requires its patch asset even when the parser is already patched', (t) => {
  const root = fixture(t);
  const scripts = join(root, 'scripts/ci');
  mkdirSync(scripts, { recursive: true });
  const entry = join(scripts, 'picomatch-security.mjs');
  cpSync('scripts/ci/picomatch-security.mjs', entry);
  cpSync('patches', join(root, 'patches'), { recursive: true });
  const run = () =>
    spawnSync(process.execPath, [entry, 'apply'], { cwd: root });
  assert.equal(run().status, 0);
  const asset = join(root, 'patches/picomatch+4.0.7.patch');
  writeFileSync(asset, readFileSync(asset, 'utf8') + '\n');
  assert.notEqual(run().status, 0);
  rmSync(asset);
  assert.notEqual(run().status, 0);
});

test('the patched matcher preserves tooling globs and narrows unsafe complex extglobs', () => {
  const pm = require('picomatch');
  for (const [pattern, input, expected, options] of [
    ['**/*', 'src/lib/index.ts', true],
    ['**/*.ts', 'src/lib/index.js', false],
    ['**/*', '.hidden', false],
    ['src/{lib,test}/*.ts', 'src/lib/index.ts', true],
    ['src/{lib,test}/*.ts', 'src/other/index.ts', false],
    ['+(a|b)', 'abba', true],
    ['*(a*|b)', 'ax', false],
    ['*(a*|b)', '*(a*|b)', true],
    ['*(f*(o))', 'fofo', true],
    ['*(b+(c)d|e*(f)g?|?(h)i@(j|k))', 'egzefffgzbcdij', true],
    ['*/*(W*, *)*', 'my/folder (Work, Accts)', true],
    ['+(*a)', 'abca', true],
    ['+(*a)', 'abc', false],
    ['*(a*)', 'abca', true],
    ['x*(a*)y', 'xy', true],
    ['+(a?*)', 'abac', true],
    ['+(a?*)', 'a', false],
    ['+(a?*)', 'aaa\n', true],
    ['+(a?*)', 'aaa\n', false, { bash: true }],
    ['+(a?*)', 'aaa\u2028', false, { bash: true }],
    ['+(a\\*)', 'a*a*', true],
  ]) {
    assert.equal(
      pm.isMatch(input, pattern, options),
      expected,
      `${pattern}: ${input}`,
    );
  }
});
