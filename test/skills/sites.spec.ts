import { expect } from 'chai';
import {
  listSiteSkillsForHost,
  loadSiteSkill,
  renderSiteSkillList,
  siteRecipeNotice,
} from '../../src/skills/sites.js';

describe('site skills', function () {
  it('lists recipes for a known host', function () {
    const skills = listSiteSkillsForHost('ebay.com');
    expect(skills.length).to.be.greaterThan(0);
    expect(skills[0].id).to.match(/^ebay\.com\//);
    expect(skills[0].description).to.be.a('string').with.length.greaterThan(0);
  });

  it('matches a host regardless of www. prefix', function () {
    const bare = listSiteSkillsForHost('ebay.com').length;
    expect(listSiteSkillsForHost('www.ebay.com').length).to.equal(bare);
  });

  it('strips a port before matching', function () {
    const bare = listSiteSkillsForHost('ebay.com').length;
    expect(listSiteSkillsForHost('ebay.com:443').length).to.equal(bare);
  });

  it('returns empty string for a host with no recipe', function () {
    expect(renderSiteSkillList('no-such-host.example')).to.equal('');
    expect(listSiteSkillsForHost('no-such-host.example')).to.deep.equal([]);
  });

  it('renders pointers, not the skill body', function () {
    const text = renderSiteSkillList('ebay.com');
    expect(text).to.include('SITE RECIPES for ebay.com');
    expect(text).to.include('browserless_skill { id:');
    expect(text).to.not.include('## Purpose');
  });

  it('loads a full skill body by id', function () {
    const id = listSiteSkillsForHost('ebay.com')[0].id;
    const body = loadSiteSkill(id);
    expect(body).to.be.a('string');
    expect(body).to.include('SITE SKILL:');
  });

  it('returns null for an unknown id', function () {
    expect(loadSiteSkill('nope.example/does-not-exist')).to.equal(null);
  });

  describe('siteRecipeNotice (proactive injection)', function () {
    it('surfaces a pointer for a known host, once per session', function () {
      const seen = new Set<string>();
      const first = siteRecipeNotice('https://www.ebay.com/sch/i.html', seen);
      expect(first).to.include('SITE RECIPE(S) available for ebay.com');
      expect(first).to.include('browserless_skill { id:');
      // Same host again in the same session → suppressed (no nagging).
      expect(siteRecipeNotice('https://ebay.com/itm/123', seen)).to.equal('');
    });

    it('does not inject the recipe body, only the pointer', function () {
      const notice = siteRecipeNotice('https://ebay.com', new Set());
      expect(notice).to.not.include('## Purpose');
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
});
