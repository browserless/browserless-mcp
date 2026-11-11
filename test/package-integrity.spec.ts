import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
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
import {
  admitSessionRequest,
  requestSessionId,
  requestSessions,
} from '../src/lib/session-binding.js';

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
        writeFileSync(join(dist, 'FastMCP.cjs'), '  updateAuth(auth) {');
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

  for (const supported of [false, true]) {
    it(`handles an SSE session-record fixture with supported=${supported}`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'sse-patch-'));
      try {
        for (const name of ['fastmcp', 'mcp-proxy']) {
          const dir = join(fixture, 'node_modules', name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ main: 'index.js' }),
          );
        }
        writeFileSync(
          join(fixture, 'node_modules/fastmcp/index.js'),
          'this.#capabilities.tools = {};\n  updateAuth(auth) {',
        );
        // Match the 6.8.0 opener and request-dispatch anchors, not just construction.
        const source = supported
          ? 'const transport = new SSEServerTransport("/messages", res);\n\t\tlet server;\n\t\ttry {\n\t\t\tserver = await createServer(req);\n\t\t} catch (error) {\n\t\t\tif (await handleResponseError(error, res)) return true;\n\t\t\tres.writeHead(500).end("Error creating server");\n\t\t\treturn true;\n\t\t}\n\t\tactiveTransports[transport.sessionId] = {\n\t\t\tserver,\n\t\t\ttransport\n\t\t};\nif (sseEndpoint && await handleSSERequest({ req, res })) return;'
          : 'const transport = new SSEServerTransport("/messages", res);\n\t\tlet server;\n\t\tserver = await createServer(req);\n\t\tactiveTransports[transport.sessionId] = { server, transport };';
        const proxy = join(fixture, 'node_modules/mcp-proxy/index.js');
        writeFileSync(proxy, source);
        const script = join(fixture, 'patch-fastmcp.mjs');
        copyFileSync(join(root, 'scripts/patch-fastmcp.mjs'), script);
        let patched = source;
        for (let run = 0; run < 2; run++) {
          execFileSync(process.execPath, [script], { stdio: 'pipe' });
          const output = readFileSync(proxy, 'utf8');
          if (!supported || run === 1) expect(output).to.equal(patched);
          patched = output;
        }
        if (supported) {
          const auth = {
            token: 'fixture+&key',
            apiUrl: 'http://127.0.0.1:9',
            authMethod: 'api_key_query' as const,
          };
          const session = { sessionId: 'fixture', auth };
          const records = {};
          const request = {
            method: 'POST',
            url: '/messages?sessionId=fixture',
          };
          const authenticate = () =>
            admitSessionRequest(
              requestSessionId(request),
              auth,
              requestSessions(request, []),
            );
          const transport = await runInNewContext(
            `(async () => { ${patched}\nreturn transport; })()`,
            {
              URL,
              URLSearchParams,
              req: request,
              res: {},
              activeTransports: records,
              activeSSETransports: records,
              sseEndpoint: '/sse',
              oauth: undefined,
              authenticate,
              createServer: async () => session,
              SSEServerTransport: class {
                sessionId = 'fixture';
                constructor(readonly endpoint: string) {}
              },
              authenticateSessionRequest: async () => {
                authenticate();
                return false;
              },
              // Native message authentication must also succeed before registration.
              handleSSERequest: async () => {
                authenticate();
                return false;
              },
            },
          );
          expect(
            new URL(transport.endpoint, 'http://localhost').searchParams.get(
              'token',
            ),
          ).to.equal(auth.token);
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

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

  it('authenticates session GET, DELETE and legacy SSE message requests', () => {
    const sources = mcpProxySources().filter((s) =>
      s.includes('const handleStreamRequest = async ({'),
    );
    expect(sources).to.have.length(1);
    expect(
      sources[0].split('const authenticateSessionRequest = async ('),
    ).to.have.length(2);
    expect(
      sources[0].split('await authenticateSessionRequest('),
    ).to.have.length(4);
    expect(sources[0].split('browserlessSession: server')).to.have.length(2);
    expect(
      sources[0].split('const activeSSESession = activeSSETransports['),
    ).to.have.length(2);
    expect(sources[0]).to.include(
      'new SSEServerTransport(messageEndpoint, res)',
    );
    expect(sources[0]).to.include(
      'new URLSearchParams({ token: openerToken })',
    );
    expect(sources[0]).not.to.include(
      'console.error("[mcp-proxy] error connecting to server", error$1)',
    );
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
    expect(() =>
      execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    ).to.not.throw();
    expect(mcpProxySources()).to.deep.equal(before);
    expect(
      distSources().some((c) => c.includes(conditionalCapability)),
      'capability must remain enabled after a second run',
    ).to.equal(true);
    expect(distSources()).to.deep.equal(fastmcpBefore);
  });
});
