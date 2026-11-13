import { expect } from 'chai';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const conditionalCapability =
  'this.#capabilities.tools = globalThis.__browserlessMcpStaticTools ? {} : { listChanged: true };';

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

  it('makes tools.listChanged conditional in the installed fastmcp', () => {
    const sources = distSources();
    expect(
      sources.some((c) => c.includes(conditionalCapability)),
      'fastmcp dist should carry the listChanged capability',
    ).to.equal(true);
    expect(
      sources.some((c) => c.includes('this.#capabilities.tools = {};')),
      'no fastmcp dist file should retain the unpatched capability',
    ).to.equal(false);
    expect(
      sources.some((c) =>
        c.includes('this.#capabilities.tools = { listChanged: true };'),
      ),
    ).to.equal(false);
  });

  for (const original of [
    'this.#capabilities.tools = {};',
    'this.#capabilities.tools = { listChanged: true };',
    conditionalCapability,
    'this.#capabilities.tools = unexpected;',
  ]) {
    it(`patches or rejects a capability fixture: ${original}`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'fastmcp-patch-'));
      try {
        const dist = join(fixture, 'node_modules/fastmcp/dist');
        mkdirSync(dist, { recursive: true });
        writeFileSync(
          join(dist, '../package.json'),
          JSON.stringify({ main: 'dist/FastMCP.cjs' }),
        );
        writeFileSync(
          join(dist, 'FastMCP.cjs'),
          '  updateAuth(auth) {\n          streamEndpoint\n        });',
        );
        const chunk = join(dist, 'chunk.js');
        writeFileSync(chunk, original);
        const script = join(fixture, 'patch-fastmcp.mjs');
        copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
        const run = () =>
          execFileSync(process.execPath, [script], {
            encoding: 'utf8',
            stdio: 'pipe',
          });
        if (original.includes('unexpected')) {
          expect(run).to.throw('target not found');
          expect(readFileSync(chunk, 'utf8')).to.equal(original);
        } else {
          run();
          expect(readFileSync(chunk, 'utf8')).to.equal(conditionalCapability);
          expect(run()).to.include('tools.listChanged: already patched');
          expect(readFileSync(chunk, 'utf8')).to.equal(conditionalCapability);
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  it('pins mcp-proxy to an exact version', () => {
    // The script also edits mcp-proxy's built dist.
    expect(pkg.overrides?.['mcp-proxy'], 'mcp-proxy must be pinned').to.match(
      /^\d+\.\d+\.\d+$/,
    );
  });

  for (const hiddenExports of [false, true]) {
    it(`patches edge priming with optional SDK exports hidden=${hiddenExports}`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'edge-context-patch-'));
      try {
        const dist = join(fixture, 'node_modules/fastmcp/dist');
        mkdirSync(join(dist, 'edge'), { recursive: true });
        writeFileSync(
          join(dist, '../package.json'),
          JSON.stringify({ main: 'dist/FastMCP.cjs' }),
        );
        writeFileSync(
          join(dist, 'FastMCP.cjs'),
          'this.#capabilities.tools = {};\n  updateAuth(auth) {',
        );
        for (const format of ['js', 'cjs'])
          writeFileSync(
            join(dist, `edge/index.${format}`),
            'function prime(streamId) { return this.store.storeEvent(streamId, {}); }',
          );
        // Consumer bundles may put the EventStore implementation in its own
        // chunk. Definitions are not transport calls and need no owner patch.
        const definitions =
          'class Store { storeEvent(streamId, message) {} replayEventsAfter(lastEventId, { send }) {} }';
        const storeChunk = join(dist, 'edge/store.mjs');
        writeFileSync(storeChunk, definitions);
        if (hiddenExports) {
          for (const name of ['server', 'sdk']) {
            const sdk = join(
              fixture,
              'node_modules/@modelcontextprotocol',
              name,
            );
            mkdirSync(sdk, { recursive: true });
            writeFileSync(
              join(sdk, 'package.json'),
              JSON.stringify({ exports: { './visible': './visible.js' } }),
            );
          }
        }
        const script = join(fixture, 'patch-fastmcp.mjs');
        copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
        const run = () =>
          execFileSync(process.execPath, [script], { stdio: 'pipe' });
        const unpatched = sourcesIn(join(dist, 'edge'), /\.(js|cjs)$/);
        const verified = spawnSync(process.execPath, [
          script,
          '--check-replay',
        ]);
        expect(verified.status).to.equal(1);
        expect(sourcesIn(join(dist, 'edge'), /\.(js|cjs)$/)).to.deep.equal(
          unpatched,
        );
        run();
        expect(readFileSync(storeChunk, 'utf8')).to.equal(definitions);
        const before = sourcesIn(join(dist, 'edge'), /\.(js|cjs)$/);
        for (const source of before) {
          const owner = runInNewContext(
            `${source}; prime.call({ activeSessionId: 'owner', store: { storeEvent: (_, __, session) => session } }, 'request')`,
          );
          expect(owner).to.equal('owner');
        }
        run();
        expect(sourcesIn(join(dist, 'edge'), /\.(js|cjs)$/)).to.deep.equal(
          before,
        );
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  it('warns and skips replay patch drift without changing any replay files', () => {
    const edgeSource = sourcesIn(join(distDir(), 'edge'), /\.js$/)[0];
    const driftedSources = [
      'let resolveReplayResponse;',
      'const refusal = await replayResponse;',
    ].map((anchor) => {
      expect(edgeSource).to.include(anchor);
      return edgeSource.replace(anchor, '// upstream drift');
    });
    driftedSources.push(
      `${edgeSource}\nstore.replayEventsAfter(differentCursor, {});`,
    );
    for (const originalDrift of driftedSources) {
      const fixture = mkdtempSync(join(tmpdir(), 'replay-patch-drift-'));
      try {
        const dist = join(fixture, 'node_modules/fastmcp/dist');
        mkdirSync(join(dist, 'edge'), { recursive: true });
        writeFileSync(
          join(dist, '../package.json'),
          JSON.stringify({ main: 'dist/FastMCP.cjs' }),
        );
        writeFileSync(
          join(dist, 'FastMCP.cjs'),
          'this.#capabilities.tools = {};\n  updateAuth(auth) {',
        );
        const prime = join(dist, 'edge/a.js');
        const drifted = join(dist, 'edge/z.js');
        const originalPrime =
          'function prime(streamId) { return this.store.storeEvent(streamId, {}); }';
        writeFileSync(prime, originalPrime);
        writeFileSync(drifted, originalDrift);
        const script = join(fixture, 'patch-fastmcp.mjs');
        copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
        const result = spawnSync(process.execPath, [script], {
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).to.equal(0);
        expect(result.stderr).to.include('retained replay disabled');
        expect(result.stdout).not.to.include('replay patch: complete');
        expect(readFileSync(prime, 'utf8')).to.equal(originalPrime);
        expect(readFileSync(drifted, 'utf8')).to.equal(originalDrift);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  });

  it('does not verify an unused SDK instead of an unknown active transport', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'replay-unused-sdk-'));
    try {
      const require = createRequire(import.meta.url);
      const sdkSource = readFileSync(
        join(
          dirname(
            require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'),
          ),
          'webStandardStreamableHttp.js',
        ),
        'utf8',
      );
      for (const [name, source] of [
        ['fastmcp', ''],
        ['mcp-proxy', 'export const unrelated = true;'],
        ['@modelcontextprotocol/sdk', sdkSource],
      ]) {
        const dependency = join(fixture, 'node_modules', name);
        const entry =
          name === '@modelcontextprotocol/sdk'
            ? 'dist/esm/server/streamableHttp.js'
            : 'dist/index.js';
        mkdirSync(dirname(join(dependency, entry)), { recursive: true });
        writeFileSync(
          join(dependency, 'package.json'),
          JSON.stringify({
            main: entry,
            version: '99.0.0',
            ...(name === '@modelcontextprotocol/sdk'
              ? {
                  exports: {
                    './server/streamableHttp.js':
                      './dist/esm/server/streamableHttp.js',
                  },
                }
              : {}),
          }),
        );
        writeFileSync(join(dependency, entry), source);
      }
      mkdirSync(join(fixture, 'scripts'));
      writeFileSync(join(fixture, 'package.json'), JSON.stringify(pkg));
      const script = join(fixture, 'scripts/patch-fastmcp.mjs');
      copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
      const result = spawnSync(process.execPath, [script, '--check-replay'], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).to.equal(1);
      expect(result.stderr).to.include('No supported active replay transport');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('fails closed on missing security patches for the pinned transport only', () => {
    const targets = [
      'const activeSSETransports = {};',
      'const activeStreamTransports = {};',
      'const cleanupServer = async (server, onClose) => {\n\tif (onClose) await onClose(server);',
      'http.createServer(requestListener)',
      'https.createServer(options, requestListener)',
      '\t\t\t\tserver.connect(transport);',
    ];
    for (const version of [pkg.overrides['mcp-proxy'], '99.0.0']) {
      for (let missing = -1; missing < targets.length; missing++) {
        const fixture = mkdtempSync(join(tmpdir(), 'transport-patch-'));
        try {
          const scripts = join(fixture, 'scripts');
          const fastmcp = join(fixture, 'node_modules/fastmcp/dist');
          const proxy = join(fixture, 'node_modules/mcp-proxy/dist');
          for (const dir of [scripts, fastmcp, proxy])
            mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(fixture, 'package.json'),
            JSON.stringify({ overrides: pkg.overrides }),
          );
          writeFileSync(
            join(fastmcp, '../package.json'),
            JSON.stringify({ main: 'dist/FastMCP.cjs' }),
          );
          writeFileSync(
            join(fastmcp, 'FastMCP.cjs'),
            'this.#capabilities.tools = {};\n  updateAuth(auth) {\n          streamEndpoint\n        });',
          );
          writeFileSync(
            join(proxy, '../package.json'),
            JSON.stringify({ version, main: 'dist/index.mjs' }),
          );
          writeFileSync(
            join(proxy, 'index.mjs'),
            targets.filter((_, index) => index !== missing).join('\n'),
          );
          const script = join(scripts, 'patch-fastmcp.mjs');
          copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
          const run = () =>
            execFileSync(process.execPath, [script], { stdio: 'pipe' });
          if (missing >= 0 && version === pkg.overrides['mcp-proxy']) {
            expect(run, `missing pinned target ${targets[missing]}`).to.throw(
              'target not found',
            );
          } else {
            run();
            run(); // Both pinned and consumer installs must stay idempotent.
          }
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      }
    }
  });
  it('disables legacy transport in both HTTP modes and Node formats', () => {
    const sources = distSources().filter((s) =>
      s.includes('const streamEndpoint = joinPaths('),
    );
    expect(sources).to.have.length(2);
    for (const source of sources) {
      expect(source.match(/sseEndpoint: null,/g)).to.have.length(2);
    }
  });

  it('removes the previous message-auth hook from a reused proxy install', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'transport-upgrade-'));
    try {
      mkdirSync(join(fixture, 'scripts'));
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ overrides: pkg.overrides }),
      );
      for (const name of ['fastmcp', 'mcp-proxy']) {
        const dir = join(fixture, 'node_modules', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            version: '99.0.0',
            main: name === 'mcp-proxy' ? 'dist/index.js' : 'index.js',
          }),
        );
      }
      writeFileSync(
        join(fixture, 'node_modules/fastmcp/index.js'),
        'this.#capabilities.tools = {};\n  updateAuth(auth) {\n          streamEndpoint\n        });',
      );
      const proxy = join(fixture, 'node_modules/mcp-proxy/dist/index.js');
      mkdirSync(dirname(proxy));
      writeFileSync(
        proxy,
        `async (req, res) => {
		if (req.method === "POST" && req.url?.startsWith("/messages")) {
			const activeSSESession = activeSSETransports[new URL(req.url, "https://example.com").searchParams.get("sessionId")];
			req.browserlessSession = activeSSESession?.browserlessSession ?? activeSSESession?.server;
			if (await authenticateSessionRequest({ authenticate, oauth, req, res })) return;
		}
		if (sseEndpoint && await handleSSERequest({ req, res })) return;
        res.writeHead(404).end();
      }`,
      );
      const script = join(fixture, 'scripts/patch-fastmcp.mjs');
      copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
      execFileSync(process.execPath, [script], { stdio: 'pipe' });
      const patched = readFileSync(proxy, 'utf8');
      execFileSync(process.execPath, [script], { stdio: 'pipe' });
      expect(readFileSync(proxy, 'utf8')).to.equal(patched);
      const listener = runInNewContext(patched, { sseEndpoint: null });
      let status: number | undefined;
      await listener(
        { method: 'POST', url: '/messages?sessionId=retired' },
        {
          writeHead: (value: number) => {
            status = value;
            return { end() {} };
          },
        },
      );
      expect(status).to.equal(404);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
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

  it('authenticates Streamable HTTP session GET and DELETE requests', () => {
    const sources = mcpProxySources().filter((s) =>
      s.includes('const handleStreamRequest = async ({'),
    );
    expect(sources).to.have.length(1);
    expect(
      sources[0].split('const authenticateSessionRequest = async ('),
    ).to.have.length(2);
    expect(
      sources[0].split('await authenticateSessionRequest('),
    ).to.have.length(3);
    expect(sources[0]).not.to.include('const activeSSESession =');
  });

  it('exposes session auth in every Node session format', () => {
    const sources = distSources().filter((s) =>
      s.includes('updateAuth(auth) {'),
    );
    expect(sources.length).to.be.greaterThan(0);
    for (const source of sources) expect(source).to.include('get auth() {');
  });

  it('re-runs idempotently without error', () => {
    const script = join(root, 'scripts', 'patch-fastmcp.mjs');
    const before = mcpProxySources();
    const fastmcpBefore = distSources();
    const edgeBefore = sourcesIn(join(distDir(), 'edge'), /\.(cjs|js)$/);
    const sdkDist = dirname(
      dirname(
        dirname(
          createRequire(import.meta.url).resolve(
            '@modelcontextprotocol/sdk/server/streamableHttp.js',
          ),
        ),
      ),
    );
    const sdkBefore = ['esm', 'cjs'].map((format) =>
      sourcesIn(join(sdkDist, format, 'server'), /StreamableHttp\.js$/i),
    );
    for (const sources of sdkBefore)
      expect(sources.length).to.be.greaterThan(0);
    expect(() =>
      execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    ).to.not.throw();
    expect(mcpProxySources()).to.deep.equal(before);
    expect(
      distSources().some((c) => c.includes(conditionalCapability)),
      'capability must remain enabled after a second run',
    ).to.equal(true);
    expect(distSources()).to.deep.equal(fastmcpBefore);
    expect(sourcesIn(join(distDir(), 'edge'), /\.(cjs|js)$/)).to.deep.equal(
      edgeBefore,
    );
    expect(
      ['esm', 'cjs'].map((format) =>
        sourcesIn(join(sdkDist, format, 'server'), /StreamableHttp\.js$/i),
      ),
    ).to.deep.equal(sdkBefore);
  });
});
