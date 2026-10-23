import { expect } from 'chai';
import sinon from 'sinon';
import {
  skillRunId,
  skillUseId,
  verifySkillReceipt,
  listSiteSkillsForHost,
  loadSiteSkill,
  renderSiteSkillList,
  siteRecipeNotice,
  hydrateRemoteSkills,
  __resetRemoteSkillsForTesting,
  __setRemoteSkillTtlForTesting,
} from '../../src/skills/sites.js';

const SKILL_BODY = [
  '---',
  'name: search',
  'title: Shop Search',
  'website: shop.example',
  '---',
  '# Shop Search',
  '## Purpose',
  'Search the catalog.',
].join('\n');

const fakeFetch =
  (skills: unknown, ok = true): typeof fetch =>
  async () =>
    ({ ok, json: async () => skills }) as unknown as Response;

const apiUrlConfig = { browserlessApiUrl: 'https://api.test' };

// Populate the manifest for shop.example the way a live fetch would.
const seedShop = () =>
  hydrateRemoteSkills(
    'https://shop.example/x',
    'https://api.test',
    'tok',
    apiUrlConfig,
    fakeFetch([{ task: 'search', title: 'Shop Search', skill_md: SKILL_BODY }]),
  );

describe('site skills', function () {
  beforeEach(() => __resetRemoteSkillsForTesting());

  it('signs the fixed receipt contract', function () {
    expect(
      skillUseId(
        'test-token',
        '96dcba170838442b7e86da88167b5c9a02cbbf5b4630bd8b5aad494a607b4890',
        'x.com',
        'search',
        1,
      ),
    ).to.equal(
      '42bb6fae7df9e171bd636e2358da9cdcec56ea8dd18503d4b99d6597a99b3c8d',
    );
  });

  it('isolates run identities by customer and session with a stable stdio fallback', function () {
    const id = skillRunId('private-token', 'private-session');
    expect(id).to.match(/^[a-f0-9]{64}$/);
    expect(id).to.equal(skillRunId('private-token', 'private-session'));
    expect(id).not.to.equal(skillRunId('another-token', 'private-session'));
    expect(id).not.to.equal(skillRunId('private-token', 'another-session'));
    expect(skillRunId('private-token', undefined)).to.equal(
      skillRunId('private-token', undefined),
    );
  });

  it('verifies only complete, bounded and authentic receipts', function () {
    const verify = verifySkillReceipt;
    const params: Record<string, unknown> = {
      domain: 'x.com',
      task: 'search',
      loaded_version: 1,
      run_id:
        '96dcba170838442b7e86da88167b5c9a02cbbf5b4630bd8b5aad494a607b4890',
      skill_use_id:
        '42bb6fae7df9e171bd636e2358da9cdcec56ea8dd18503d4b99d6597a99b3c8d',
    };
    expect(verify('test-token', params)).to.equal(true);
    for (const token of ['other-token', ''])
      expect(verify(token, params)).to.equal(false);
    for (const [key, value] of [
      ['loaded_version', 2],
      ['loaded_version', 0],
      ['loaded_version', 1.5],
      ['loaded_version', Number.MAX_SAFE_INTEGER + 1],
      ['loaded_version', '1'],
      ['domain', 'y.com'],
      ['domain', ''],
      ['domain', 'x'.repeat(254)],
      ['domain', 1],
      ['task', 'browse'],
      ['task', ''],
      ['task', 'x'.repeat(129)],
      ['task', null],
      ['run_id', String(params.run_id).toUpperCase()],
      ['run_id', 'a'.repeat(63)],
      ['run_id', 1],
      ['skill_use_id', String(params.skill_use_id).toUpperCase()],
      ['skill_use_id', 'a'.repeat(63)],
      ['skill_use_id', null],
      ...Object.keys(params).map((key) => [key, undefined]),
    ])
      expect(
        verify('test-token', { ...params, [key as string]: value }),
        String(key),
      ).to.equal(false);
  });

  it('keeps a valid loaded version without rejecting legacy recipe payloads', async function () {
    for (const version of [3, 0, 1.5, '3', null, undefined]) {
      __resetRemoteSkillsForTesting();
      await hydrateRemoteSkills(
        'https://shop.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        fakeFetch([{ task: 'search', skill_md: SKILL_BODY, version }]),
      );
      expect(listSiteSkillsForHost('shop.example')).to.have.length(1);
      expect(listSiteSkillsForHost('shop.example')[0]).to.have.property(
        'version',
        version === 3 ? 3 : undefined,
      );
      const legacy = [
        '--- SITE SKILL: shop.example/search ---',
        SKILL_BODY,
        'When you finish, put { "method": "reportSkillOutcome", "params": { "domain": "shop.example", "task": "search", "success": <bool> } } ' +
          'in your last commands batch while the browser is still open (before close). Send success: false if a step in this recipe failed as written, ' +
          'even if you finished another way; use failure_reason: "site_changed" when a URL or element no longer matches. ' +
          "Cosmetic differences that didn't break a step are still success: true.",
        '--- END SITE SKILL ---',
      ].join('\n');
      const unattributed = loadSiteSkill('shop.example/search')!;
      expect(unattributed.body).to.equal(legacy);
      expect(unattributed).not.to.have.property('receipt');
      for (const token of ['', 'private-token']) {
        if (version === 3 && token) continue;
        const loaded = loadSiteSkill('shop.example/search', {
          token,
          mcpSessionId: 'private-session',
        })!;
        expect(loaded.body).to.equal(legacy);
        expect(loaded).not.to.have.property('receipt');
      }
    }
  });

  it('returns a versioned receipt in the loaded recipe footer without exposing credentials', async function () {
    await hydrateRemoteSkills(
      'https://shop.example',
      'https://api.test',
      'tok',
      apiUrlConfig,
      fakeFetch([{ task: 'search', skill_md: SKILL_BODY, version: 3 }]),
    );
    const loaded = loadSiteSkill('shop.example/search', {
      token: 'private-token',
      mcpSessionId: 'private-session',
    })!;
    expect(loaded).to.have.property('receipt');
    expect(loaded.receipt!.loaded_version).to.equal(3);
    expect(
      verifySkillReceipt('private-token', {
        ...loaded.receipt,
        domain: 'shop.example',
        task: 'search',
      }),
    ).to.equal(true);
    for (const [key, value] of Object.entries(loaded.receipt!))
      expect(loaded.body).to.include(`"${key}": ${JSON.stringify(value)}`);
    expect(loaded.body).to.include(
      'Copy run_id, skill_use_id and loaded_version exactly as shown; never invent them.',
    );
    expect(JSON.stringify(loaded)).not.to.match(
      /private-token|private-session/,
    );
  });

  it('has no skills for a host until it is hydrated', function () {
    expect(listSiteSkillsForHost('shop.example')).to.deep.equal([]);
    expect(renderSiteSkillList('shop.example')).to.equal('');
  });

  it('lists recipes once a host is hydrated', async function () {
    await seedShop();
    const skills = listSiteSkillsForHost('shop.example');
    expect(skills.map((s) => s.id)).to.deep.equal(['shop.example/search']);
  });

  it('matches a host regardless of www. prefix or port', async function () {
    await seedShop();
    const base = listSiteSkillsForHost('shop.example').length;
    expect(listSiteSkillsForHost('www.shop.example').length).to.equal(base);
    expect(listSiteSkillsForHost('shop.example:443').length).to.equal(base);
  });

  it('renders pointers, not the skill body', async function () {
    await seedShop();
    const text = renderSiteSkillList('shop.example');
    expect(text).to.include('SITE RECIPES for shop.example');
    expect(text).to.include('browserless_skill { id:');
    expect(text).to.not.include('## Purpose');
  });

  it('loads a full skill body by id', async function () {
    await seedShop();
    const body = loadSiteSkill('shop.example/search')?.body;
    expect(body).to.include('SITE SKILL:');
    expect(body).to.include(SKILL_BODY);
    expect(body).to.include(
      '{ "method": "reportSkillOutcome", "params": { "domain": "shop.example", "task": "search", "success": <bool> } }',
    );
    expect(body).to.include('while the browser is still open (before close)');
    expect(body).not.to.include('before reportOutcome');
    expect(body).to.include(
      'success: false if a step in this recipe failed as written',
    );
    expect(body).to.include('even if you finished another way');
    expect(body).to.include('failure_reason: "site_changed"');
    expect(body).to.include(
      "Cosmetic differences that didn't break a step are still success: true.",
    );
    expect(body).to.match(
      /Search the catalog\.\nWhen you finish,[^\n]+\n--- END SITE SKILL ---$/,
    );
  });

  it('returns null for an unknown id', function () {
    expect(loadSiteSkill('nope.example/does-not-exist')).to.equal(null);
  });

  describe('siteRecipeNotice (proactive injection)', function () {
    it('surfaces a pointer for a hydrated host, once per session', async function () {
      await seedShop();
      const seen = new Set<string>();
      const first = siteRecipeNotice('https://www.shop.example/a', seen);
      expect(first).to.include('SITE RECIPE(S) available for shop.example');
      expect(first).to.include('browserless_skill { id:');
      expect(siteRecipeNotice('https://shop.example/b', seen)).to.equal('');
    });

    it('does not inject the recipe body, only the pointer', async function () {
      await seedShop();
      expect(
        siteRecipeNotice('https://shop.example', new Set()),
      ).to.not.include('## Purpose');
    });

    it('returns empty for a host with no recipe (and marks it seen)', function () {
      const seen = new Set<string>();
      expect(siteRecipeNotice('https://no-such-host.example', seen)).to.equal(
        '',
      );
      expect(seen.has('no-such-host.example')).to.equal(true);
    });

    it('returns empty for a missing or malformed url', function () {
      const seen = new Set<string>();
      expect(siteRecipeNotice(undefined, seen)).to.equal('');
      expect(siteRecipeNotice('not a url', seen)).to.equal('');
    });
  });

  describe('hydrateRemoteSkills (enterprise GET /skills)', function () {
    it('classifies a broken response stream as network failure, not malformed JSON', async function () {
      const events: Record<string, unknown>[] = [];
      const fetcher: typeof fetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new TypeError('terminated secret stream');
          },
        }) as unknown as Response;
      await hydrateRemoteSkills(
        'https://shop.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        fetcher,
        (event) => events.push(event),
      );
      expect(events).to.have.length(1);
      expect(events[0]).to.include({
        result: 'error',
        stage: 'decode',
        error_category: 'network_error',
        http_status: 200,
      });
      expect(JSON.stringify(events)).not.to.include('secret');
    });

    it('completes each transport attempt, not cache reads, with classified outcomes', async function () {
      const events: Record<string, unknown>[] = [];
      const outcomes: [unknown, string, string | undefined][] = [
        [
          [{ task: 'search', title: 'Search', skill_md: SKILL_BODY }],
          'hit',
          undefined,
        ],
        [[], 'miss', undefined],
        [{ skills: [] }, 'error', 'invalid_shape'],
        [[null], 'error', 'invalid_shape'],
        [[{ task: 'search', skill_md: 17 }], 'error', 'invalid_shape'],
      ];
      for (const [body, result, category] of outcomes) {
        __resetRemoteSkillsForTesting();
        const fetcher = sinon.spy(fakeFetch(body));
        const retrieve = () =>
          hydrateRemoteSkills(
            'https://www.shop.example/path?password=secret',
            'https://api.test',
            'secret-token',
            apiUrlConfig,
            fetcher,
            (event: Record<string, unknown>) => events.push(event),
          );
        await retrieve();
        await retrieve();
        expect(fetcher.callCount).to.equal(result === 'error' ? 2 : 1);
        const recent = events.splice(0);
        expect(recent).to.have.length(fetcher.callCount);
        for (const event of recent) {
          expect(event).to.include({
            result,
            domain: 'shop.example',
            attempt: 1,
          });
          expect(event.error_category).to.equal(category);
          expect(event.duration_ms).to.be.at.least(0);
          expect(event.request_id).to.match(/^[0-9a-f-]{36}$/);
          if (result === 'error')
            expect(event).not.to.have.property('skill_count');
          else expect(event.skill_count).to.equal(result === 'hit' ? 1 : 0);
          expect(JSON.stringify(event)).not.to.match(
            /secret|password|skill_md|path/,
          );
        }
      }
    });

    it('distinguishes HTTP, JSON, network and timeout failures without additional retries', async function () {
      const cases: [typeof fetch, string, number | undefined][] = [
        ...[401, 403, 429, 500].map(
          (status) =>
            [
              async () => new Response('secret body', { status }),
              'http_error',
              status,
            ] as [typeof fetch, string, number],
        ),
        [async () => new Response('not JSON'), 'invalid_json', 200],
        [
          async () => {
            throw new Error('https://private/?token=secret');
          },
          'network_error',
          undefined,
        ],
        [
          async (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            }),
          'timeout',
          undefined,
        ],
      ];
      for (const [transport, category, status] of cases) {
        __resetRemoteSkillsForTesting();
        const fetcher = sinon.spy(transport);
        const events: Record<string, unknown>[] = [];
        const pending = hydrateRemoteSkills(
          'https://shop.example',
          'https://api.test',
          'secret-token',
          apiUrlConfig,
          fetcher,
          (event: Record<string, unknown>) => events.push(event),
        );
        await pending;
        expect(fetcher.callCount).to.equal(1);
        expect(events).to.have.length(1);
        expect(events[0]).to.include({
          result: 'error',
          error_category: category,
        });
        expect(events[0].http_status).to.equal(status);
        expect(events[0]).not.to.have.property('skill_count');
        expect(JSON.stringify(events)).not.to.match(/private|secret|token/);
      }
    });

    it('keeps a valid result when completion telemetry throws', async function () {
      await hydrateRemoteSkills(
        'https://shop.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        fakeFetch([{ task: 'search', skill_md: SKILL_BODY }]),
        () => {
          throw new Error('telemetry unavailable');
        },
      );
      expect(loadSiteSkill('shop.example/search')?.body).to.include(
        '# Shop Search',
      );
    });

    it('merges remote skills into the manifest for a new host', async function () {
      expect(listSiteSkillsForHost('shop.example')).to.deep.equal([]);
      await seedShop();
      expect(loadSiteSkill('shop.example/search')?.body).to.include(
        '# Shop Search',
      );
    });

    it('fetches at most once per host', async function () {
      let calls = 0;
      const counting: typeof fetch = async () => {
        calls++;
        return { ok: true, json: async () => [] } as unknown as Response;
      };
      await hydrateRemoteSkills(
        'https://c.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        counting,
      );
      await hydrateRemoteSkills(
        'https://c.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        counting,
      );
      expect(calls).to.equal(1);
    });

    it('shares the in-flight fetch across concurrent callers', async function () {
      let calls = 0;
      const slow: typeof fetch = async () => {
        calls++;
        return {
          ok: true,
          json: async () => [
            { task: 'search', title: 'Shop Search', skill_md: SKILL_BODY },
          ],
        } as unknown as Response;
      };
      await Promise.all([
        hydrateRemoteSkills(
          'https://shop.example/a',
          'https://api.test',
          'tok',
          apiUrlConfig,
          slow,
        ),
        hydrateRemoteSkills(
          'https://shop.example/b',
          'https://api.test',
          'tok',
          apiUrlConfig,
          slow,
        ),
      ]);
      expect(calls).to.equal(1);
      expect(
        listSiteSkillsForHost('shop.example').map((s) => s.slug),
      ).to.deep.equal(['search']);
    });

    it('never throws and leaves the host empty on fetch failure', async function () {
      const throwing: typeof fetch = async () => {
        throw new Error('network down');
      };
      await hydrateRemoteSkills(
        'https://f.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        throwing,
      );
      expect(listSiteSkillsForHost('f.example')).to.deep.equal([]);
    });

    it('retries after a failure instead of caching it for the process', async function () {
      let calls = 0;
      const flaky: typeof fetch = async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return {
          ok: true,
          json: async () => [
            { task: 'search', title: 'Shop Search', skill_md: SKILL_BODY },
          ],
        } as unknown as Response;
      };
      await hydrateRemoteSkills(
        'https://r.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        flaky,
      );
      expect(listSiteSkillsForHost('r.example')).to.deep.equal([]);
      // Second goto retries (the failed attempt was not cached) and succeeds.
      await hydrateRemoteSkills(
        'https://r.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        flaky,
      );
      expect(calls).to.equal(2);
      expect(
        listSiteSkillsForHost('r.example').map((s) => s.slug),
      ).to.deep.equal(['search']);
    });

    it('caches a successful empty response (no per-goto refetch storm)', async function () {
      let calls = 0;
      const emptyOk: typeof fetch = async () => {
        calls++;
        return { ok: true, json: async () => [] } as unknown as Response;
      };
      await hydrateRemoteSkills(
        'https://e.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        emptyOk,
      );
      await hydrateRemoteSkills(
        'https://e.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        emptyOk,
      );
      expect(calls).to.equal(1);
    });

    it('refetches a host once the TTL lapses', async function () {
      __setRemoteSkillTtlForTesting(0);
      let calls = 0;
      const counting: typeof fetch = async () => {
        calls++;
        return {
          ok: true,
          json: async () => [
            { task: 'search', title: 'Shop Search', skill_md: SKILL_BODY },
          ],
        } as unknown as Response;
      };
      await hydrateRemoteSkills(
        'https://t.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        counting,
      );
      await hydrateRemoteSkills(
        'https://t.example',
        'https://api.test',
        'tok',
        apiUrlConfig,
        counting,
      );
      expect(calls).to.equal(2);
    });

    it('drops recipes deleted or renamed upstream on refetch', async function () {
      __setRemoteSkillTtlForTesting(0);
      await seedShop();
      expect(loadSiteSkill('shop.example/search')?.body).to.include(
        '# Shop Search',
      );

      await hydrateRemoteSkills(
        'https://shop.example/x',
        'https://api.test',
        'tok',
        apiUrlConfig,
        fakeFetch([
          { task: 'browse', title: 'Shop Browse', skill_md: SKILL_BODY },
        ]),
      );
      expect(
        listSiteSkillsForHost('shop.example').map((s) => s.slug),
      ).to.deep.equal(['browse']);
      expect(loadSiteSkill('shop.example/search')).to.equal(null);

      await hydrateRemoteSkills(
        'https://shop.example/x',
        'https://api.test',
        'tok',
        apiUrlConfig,
        fakeFetch([]),
      );
      expect(listSiteSkillsForHost('shop.example')).to.deep.equal([]);
      expect(loadSiteSkill('shop.example/browse')).to.equal(null);
    });

    it('is a no-op without a url, apiUrl, or token', async function () {
      await hydrateRemoteSkills(
        undefined,
        'https://api.test',
        'tok',
        apiUrlConfig,
        fakeFetch([]),
      );
      await hydrateRemoteSkills(
        'https://x.example',
        undefined,
        'tok',
        apiUrlConfig,
        fakeFetch([]),
      );
      await hydrateRemoteSkills(
        'https://x.example',
        'https://api.test',
        undefined,
        apiUrlConfig,
        fakeFetch([]),
      );
      expect(listSiteSkillsForHost('x.example')).to.deep.equal([]);
    });

    it('rejects a disallowed API URL before fetching or exposing the token', async function () {
      let calls = 0;
      const counting: typeof fetch = async () => {
        calls++;
        return { ok: true, json: async () => [] } as unknown as Response;
      };

      await hydrateRemoteSkills(
        'https://shop.example',
        'http://127.0.0.1:9999',
        'secret-token',
        apiUrlConfig,
        counting,
      );

      expect(calls).to.equal(0);
    });

    it('preserves the exact allowed skills endpoint', async function () {
      let requestedUrl = '';
      const recording: typeof fetch = async (input) => {
        requestedUrl = String(input);
        return { ok: true, json: async () => [] } as unknown as Response;
      };

      await hydrateRemoteSkills(
        'https://shop.example/path',
        'https://production-lon.browserless.io',
        'secret token',
        apiUrlConfig,
        recording,
      );

      expect(requestedUrl).to.equal(
        'https://production-lon.browserless.io/skills?domain=shop.example&token=secret%20token',
      );
    });
  });
});
