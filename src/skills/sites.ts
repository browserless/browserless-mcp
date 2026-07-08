import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SiteSkill {
  id: string; // `${host}/${slug}` — the loadable id
  host: string;
  slug: string;
  title: string;
  description: string;
  path: string; // absolute path to SKILL.md
}

const sitesDir = join(dirname(fileURLToPath(import.meta.url)), 'sites');

// Minimal frontmatter reader: we author these files, so we only need `name`,
// `title`, and `description`, including YAML folded scalars (`>-`, `|`). Not a
// general YAML parser.
// ponytail: line-based, handles the fields we emit; swap for a YAML lib if the
// frontmatter ever grows nested structures we need to read.
const parseFrontmatter = (raw: string): Record<string, string> => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  const folded: string[] = [];
  let foldedKey = '';
  const flush = () => {
    if (foldedKey) out[foldedKey] = folded.join(' ').trim();
    folded.length = 0;
    foldedKey = '';
  };
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      flush();
      const [, k, v] = kv;
      if (v === '>' || v === '>-' || v === '|' || v === '|-') {
        foldedKey = k;
      } else {
        out[k] = v.replace(/^['"]|['"]$/g, '');
      }
    } else if (foldedKey && /^\s/.test(line)) {
      folded.push(line.trim());
    }
  }
  flush();
  return out;
};

const buildManifest = (): Map<string, SiteSkill[]> => {
  const byHost = new Map<string, SiteSkill[]>();
  if (!existsSync(sitesDir)) return byHost;

  const hosts = readdirSync(sitesDir, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );
  for (const hostDir of hosts) {
    const host = hostDir.name.toLowerCase();
    const hostPath = join(sitesDir, hostDir.name);
    const slugs = readdirSync(hostPath, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    for (const slugDir of slugs) {
      const skillPath = join(hostPath, slugDir.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const fm = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
      const slug = slugDir.name;
      const entry: SiteSkill = {
        id: `${hostDir.name}/${slug}`,
        host,
        slug,
        title: fm.title || fm.name || slug,
        description: fm.description || '',
        path: skillPath,
      };
      const list = byHost.get(host);
      if (list) list.push(entry);
      else byHost.set(host, [entry]);
    }
  }
  return byHost;
};

const manifest = buildManifest();
const byId = new Map<string, SiteSkill>(
  [...manifest.values()].flat().map((s) => [s.id.toLowerCase(), s]),
);

// A page host may carry a `www.` prefix the skill directory doesn't (or vice
// versa); try the host as given, then toggle the prefix.
const lookupHost = (host: string): SiteSkill[] => {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return (
    manifest.get(h) ??
    manifest.get(h.replace(/^www\./, '')) ??
    manifest.get(`www.${h}`) ??
    []
  );
};

export const listSiteSkillsForHost = (host: string): SiteSkill[] =>
  lookupHost(host);

export const renderSiteSkillList = (host: string): string => {
  const skills = lookupHost(host);
  if (skills.length === 0) return '';
  const lines = skills.map(
    (s) =>
      `- ${s.id}${s.title ? ` — ${s.title}` : ''}\n` +
      (s.description ? `    ${s.description}\n` : '') +
      `    load: browserless_skill { id: "${s.id}" }`,
  );
  return [
    `--- SITE RECIPES for ${host} ---`,
    ...lines,
    '--- END SITE RECIPES ---',
  ].join('\n');
};

// Proactive pointer for the batch's current URL: fires once per host per
// session. Surfaces the recipe *pointer* (never the body) so a from-scratch
// plan doesn't beat a tuned recipe just because prose ordering got skipped.
export const siteRecipeNotice = (
  url: string | undefined,
  seen: Set<string>,
): string => {
  if (!url) return '';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (seen.has(host)) return '';
  seen.add(host);
  const skills = lookupHost(host);
  if (skills.length === 0) return '';
  return [
    `⚠ ${skills.length} SITE RECIPE(S) available for ${host} — a tuned recipe for this site.`,
    'Load and follow the matching one BEFORE planning your own steps:',
    renderSiteSkillList(host),
  ].join('\n');
};

export const loadSiteSkill = (id: string): string | null => {
  const skill = byId.get(id.toLowerCase());
  if (!skill) return null;
  return [
    `--- SITE SKILL: ${skill.id} ---`,
    readFileSync(skill.path, 'utf-8').trimEnd(),
    '--- END SITE SKILL ---',
  ].join('\n');
};
