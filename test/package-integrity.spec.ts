import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const distDir = () =>
  dirname(createRequire(import.meta.url).resolve('fastmcp'));
const sourcesIn = (dir: string, files: RegExp) =>
  readdirSync(dir)
    .filter((f) => files.test(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'));
const distSources = () => sourcesIn(distDir(), /\.(cjs|js)$/);
// mcp-proxy as fastmcp resolves it (nested under fastmcp or hoisted).
const mcpProxySources = () =>
  sourcesIn(
    dirname(
      createRequire(createRequire(import.meta.url).resolve('fastmcp')).resolve(
        'mcp-proxy',
      ),
    ),
    /\.(mjs|js)$/,
  );

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

  it('pins mcp-proxy to an exact version', () => {
    // The script also edits mcp-proxy's built dist.
    expect(pkg.overrides?.['mcp-proxy'], 'mcp-proxy must be pinned').to.match(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it("has unchained mcp-proxy's bundled SSE stream writer", () => {
    const sources = mcpProxySources();
    expect(
      sources.some((c) =>
        c.includes('else reader.read().then(flow, handleStreamError);'),
      ),
      'mcp-proxy dist should carry the unchained stream writer',
    ).to.equal(true);
    expect(
      sources.some((c) =>
        c.includes('else return reader.read().then(flow, handleStreamError);'),
      ),
      'no mcp-proxy dist file should retain the chaining stream writer',
    ).to.equal(false);
  });

  it('supplies event-store context in every shipped transport format', () => {
    const sdkDist = dirname(
      dirname(
        dirname(
          createRequire(import.meta.url).resolve(
            '@modelcontextprotocol/sdk/server/streamableHttp.js',
          ),
        ),
      ),
    );
    const variants = [
      [mcpProxySources(), 'sessionId'],
      ...['esm', 'cjs'].map((format) => [
        sourcesIn(join(sdkDist, format, 'server'), /StreamableHttp\.js$/),
        'sessionId',
      ]),
      [sourcesIn(join(distDir(), 'edge'), /\.(cjs|js)$/), 'activeSessionId'],
    ] as [string[], string][];
    for (const [sources, context] of variants) {
      const source = sources.join('\n');
      const writes = [...source.matchAll(/\.storeEvent\(([^\n;]+)\)/g)];
      const replays = [
        ...source.matchAll(/\.replayEventsAfter\(lastEventId, \{([^\n]*)/g),
      ];
      expect(writes.length).to.be.greaterThan(0);
      expect(replays.length).to.be.greaterThan(0);
      for (const match of writes)
        expect(match[1]).to.match(new RegExp(`, this\\.${context}$`));
      for (const match of replays)
        expect(match[1]).to.include(`sessionId: this.${context},`);
    }
  });

  it('re-runs idempotently without error', () => {
    const script = join(root, 'scripts', 'patch-fastmcp.mjs');
    const before = mcpProxySources();
    expect(() =>
      execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    ).to.not.throw();
    expect(mcpProxySources()).to.deep.equal(before);
    expect(
      distSources().some((c) => c.includes('listChanged: true')),
      'capability must remain enabled after a second run',
    ).to.equal(true);
  });
});
