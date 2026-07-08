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

// Minimal reader for the fields we emit (name/title/description), including
// folded scalars (`>-`, `|`). Not general YAML.
// ponytail: swap for a YAML lib if the frontmatter ever grows nested structures.
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
export const listSiteSkillsForHost = (host: string): SiteSkill[] => {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return (
    manifest.get(h) ??
    manifest.get(h.replace(/^www\./, '')) ??
    manifest.get(`www.${h}`) ??
    []
  );
};

export const renderSiteSkillList = (host: string): string => {
  const skills = listSiteSkillsForHost(host);
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

// Proactive, once-per-host pointer for the batch's URL — surfaces the recipe
// *pointer* (never the body) so a tuned recipe isn't lost to prose ordering.
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
  const skills = listSiteSkillsForHost(host);
  // Dedup on the canonical recipe host so www./bare variants count as one.
  const canonical = skills.length > 0 ? skills[0].host : host;
  if (seen.has(canonical)) return '';
  seen.add(canonical);
  if (skills.length === 0) return '';
  return [
    `⚠ ${skills.length} SITE RECIPE(S) available for ${canonical} — a tuned recipe for this site.`,
    'Load and follow the matching one BEFORE planning your own steps:',
    renderSiteSkillList(canonical),
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
