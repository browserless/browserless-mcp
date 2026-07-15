export interface SiteSkill {
  id: string; // `${host}/${slug}` — the loadable id
  host: string;
  slug: string;
  title: string;
  description: string;
  body: string; // in-memory SKILL.md fetched from the enterprise skill bucket
}

// Skills are served by the enterprise API, not bundled; the manifest fills in
// as hydrateRemoteSkills fetches each host.
const manifest = new Map<string, SiteSkill[]>();
const byId = new Map<string, SiteSkill>();

const bareHost = (host: string): string =>
  host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');

export const listSiteSkillsForHost = (host: string): SiteSkill[] =>
  manifest.get(bareHost(host)) ?? [];

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
    skill.body.trimEnd(),
    '--- END SITE SKILL ---',
  ].join('\n');
};

// Skills live in the enterprise API (GET /skills): fetch a host's skills into
// the manifest on first goto. A slow or failed fetch is a no-op, never a stall.

const REMOTE_SKILL_TIMEOUT_MS = 2500;
const hydrations = new Map<string, Promise<void>>();

interface RemoteSkill {
  task?: string;
  title?: string;
  skill_md?: string;
}

const mergeRemoteSkills = (key: string, remote: RemoteSkill[]): void => {
  const entries: SiteSkill[] = [];
  for (const { task, title, skill_md } of remote) {
    if (!task || !skill_md) continue;
    const entry: SiteSkill = {
      id: `${key}/${task}`,
      host: key,
      slug: task,
      title: title || task,
      description: '',
      body: skill_md,
    };
    entries.push(entry);
    byId.set(entry.id.toLowerCase(), entry);
  }
  manifest.set(key, entries);
};

const fetchAndMerge = async (
  key: string,
  host: string,
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> => {
  const endpoint = `${apiUrl.replace(/\/+$/, '')}/skills?domain=${encodeURIComponent(
    host,
  )}&token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_SKILL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, { signal: controller.signal });
    if (!res.ok) return;
    const skills = (await res.json()) as RemoteSkill[];
    if (Array.isArray(skills) && skills.length) mergeRemoteSkills(key, skills);
  } catch {
    // network error / timeout / bad JSON — nothing to serve for this host
  } finally {
    clearTimeout(timeout);
  }
};

export const hydrateRemoteSkills = (
  url: string | undefined,
  apiUrl: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  if (!url || !apiUrl || !token) return Promise.resolve();

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return Promise.resolve();
  }

  const key = bareHost(host);
  const inflight = hydrations.get(key);
  if (inflight) return inflight;

  const p = fetchAndMerge(key, host, apiUrl, token, fetchImpl);
  hydrations.set(key, p); // kept after settle → one fetch per host per process
  return p;
};

export const __resetRemoteSkillsForTesting = (): void => {
  hydrations.clear();
  manifest.clear();
  byId.clear();
};
