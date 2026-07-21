import { expect } from 'chai';
import {
  listSiteSkillsForHost,
  loadSiteSkill,
  renderSiteSkillList,
  siteRecipeNotice,
  hydrateRemoteSkills,
  __resetRemoteSkillsForTesting,
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

// Populate the manifest for shop.example the way a live fetch would.
const seedShop = () =>
  hydrateRemoteSkills(
    'https://shop.example/x',
    'https://api.test',
    'tok',
    fakeFetch([{ task: 'search', title: 'Shop Search', skill_md: SKILL_BODY }]),
  );

describe('site skills', function () {
  beforeEach(() => __resetRemoteSkillsForTesting());

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
    const body = loadSiteSkill('shop.example/search');
    expect(body).to.include('SITE SKILL:');
    expect(body).to.include('## Purpose');
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
    it('merges remote skills into the manifest for a new host', async function () {
      expect(listSiteSkillsForHost('shop.example')).to.deep.equal([]);
      await seedShop();
      expect(loadSiteSkill('shop.example/search')).to.include('# Shop Search');
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
        counting,
      );
      await hydrateRemoteSkills(
        'https://c.example',
        'https://api.test',
        'tok',
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
          slow,
        ),
        hydrateRemoteSkills(
          'https://shop.example/b',
          'https://api.test',
          'tok',
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
        flaky,
      );
      expect(listSiteSkillsForHost('r.example')).to.deep.equal([]);
      // Second goto retries (the failed attempt was not cached) and succeeds.
      await hydrateRemoteSkills(
        'https://r.example',
        'https://api.test',
        'tok',
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
        emptyOk,
      );
      await hydrateRemoteSkills(
        'https://e.example',
        'https://api.test',
        'tok',
        emptyOk,
      );
      expect(calls).to.equal(1);
    });

    it('is a no-op without a url, apiUrl, or token', async function () {
      await hydrateRemoteSkills(
        undefined,
        'https://api.test',
        'tok',
        fakeFetch([]),
      );
      await hydrateRemoteSkills(
        'https://x.example',
        undefined,
        'tok',
        fakeFetch([]),
      );
      await hydrateRemoteSkills(
        'https://x.example',
        'https://api.test',
        undefined,
        fakeFetch([]),
      );
      expect(listSiteSkillsForHost('x.example')).to.deep.equal([]);
    });
  });
});
