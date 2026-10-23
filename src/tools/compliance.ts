import type { McpConfig, SkillId } from '../@types/types.js';
import { detectSkills } from '../skills/index.js';

// Compliance policy for the MCP_COMPLIANCE_MODE surface, which the OpenAI /
// Anthropic directories accept but the full one they reject: the isCompliant
// gate, COMPLIANT_SKILLS allowlist + visibleSkills filter, compliant descriptions.
export {
  CompliantAgentCommandSchema,
  CompliantAgentParamsSchema,
  CompliantAgentToolParamsSchema,
  COMPLIANT_AGENT_METHODS,
} from './schemas.js';

export const isCompliant = (config: McpConfig): boolean =>
  config.complianceMode === true;

export const announceToolListOnConnect = (
  session: {
    triggerListChangedNotification: (method: string) => Promise<void>;
  },
  config: McpConfig,
): void => {
  if (!isCompliant(config))
    void session.triggerListChangedNotification(
      'notifications/tools/list_changed',
    );
};

export const READ_PAGE_DESCRIPTION =
  "Open one web page in a real browser and return what it shows in one of four formats: text (the visible text), html (the page HTML), links (each link's text and absolute address) or elements (headings, links, buttons, form fields and images, one per line). Use it to read a page that needs JavaScript to render, or to list its links. It only reads: it does not click, type or sign in, and the browser closes after each call. Optionally wait for a CSS selector or a number of milliseconds before reading, and limit text or html to part of the page with a CSS selector. Long text and HTML are cut at 50,000 characters.";

// Fail-closed allowlist — a new registry skill does NOT auto-appear, add it
// deliberately. Omits captchas (circumvention), autonomous-login/auth-profile
// (login), file-transfers (file I/O). Typed so a bad id breaks the build.
export const COMPLIANT_SKILLS: ReadonlySet<SkillId> = new Set<SkillId>([
  'shadow-dom',
  'cookie-consent',
  'modals',
  'snapshot-misses',
  'dynamic-content',
  'screenshots',
  'vision-fallback',
  'tabs',
]);

// Auto-injection filter: in compliant mode only allowlisted skills survive, so a
// restricted or unvetted recipe never auto-injects. The enum uses the same set.
export const visibleSkills = (
  ids: ReadonlyArray<SkillId>,
  compliant: boolean,
): SkillId[] =>
  compliant ? ids.filter((id) => COMPLIANT_SKILLS.has(id)) : ids.slice();

// detectSkills + visibleSkills, composed here (not agent.ts) so an auto-inject
// site imports only the filtered wrapper — raw detectSkills won't resolve there.
export const detectVisibleSkills = (
  ctx: Parameters<typeof detectSkills>[0],
  state: Parameters<typeof detectSkills>[1],
  compliant: boolean,
): SkillId[] => visibleSkills(detectSkills(ctx, state), compliant);

// The compliant agent description is COMPLIANT_AGENT_SYSTEM_PROMPT (system-prompt.ts).
export const COMPLIANT_SEARCH_DESCRIPTION =
  'Search the web and return a list of results, each with a title, URL and short snippet (news results add a date; image results add the image address). Use it to find pages, sources or recent news on a topic. It does not read the pages themselves: pass a result URL to browserless_read_page or browserless_export to read it. Filter by language, country, location, time range (day, week, month, year), source (web, news, images) or category (github, research, pdf).';

export const COMPLIANT_EXPORT_DESCRIPTION =
  'Fetch one web page by URL and return its content as text in its own format: HTML, plain text, JSON or XML. Use it when you need the raw source of a known page. It only reads the page: it does not click, fill forms or sign in, and for files such as PDFs or images it returns a short note instead of the file. To find pages, use browserless_search or browserless_map; to read the visible text, links or elements of a page, use browserless_read_page.';

export const COMPLIANT_PERFORMANCE_DESCRIPTION =
  'Run a Lighthouse audit on a web page and return the category scores (performance, accessibility, best practices, SEO, PWA) and lab metrics (FCP, LCP, TBT, CLS, Speed Index, initial server response time, total transfer size) in the reply. Use it to answer speed and quality questions about a URL. Optionally limit the categories or emulate a mobile or desktop device. INP is not measured by this navigation audit; TBT is a responsiveness proxy. Audits take 30-120 seconds.';

export const COMPLIANT_MAP_DESCRIPTION =
  'List the URLs of a website, found from its sitemap and the links on its pages, without fetching page content. Use it to see which pages a site has before reading specific ones with browserless_read_page or browserless_export. Optionally order the results by relevance to a search phrase, include, skip or use only the sitemap, and limit the count (up to 500).';

export const COMPLIANT_SKILL_TOOL_DESCRIPTION = `Load a Browserless agent skill on demand.

Use this when you suspect the page exhibits a non-trivial mechanic but no SKILL block was auto-injected into a previous response. The auto-injection heuristics are conservative; calling this tool is the explicit fallback.

Available skills:
- **shadow-dom** — deep selectors, iframe URL-pattern syntax, what works through deep-ref
- **cookie-consent** — vendor-specific dismiss recipes (OneTrust, Cookiebot, Didomi, etc.)
- **modals** — close-button heuristics, ESC handling, alertdialog vs. dialog
- **snapshot-misses** — truncated/empty snapshots, image-rendered content
- **dynamic-content** — choosing the right \`wait*\` method after async triggers
- **screenshots** — when to screenshot vs. snapshot, scope and format choices
- **vision-fallback** — click by coordinate when a \`< \` deep selector still can't surface the element
- **tabs** — multi-tab workflows, peek-without-switching`;
