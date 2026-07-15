import type { McpConfig, SkillId } from '../@types/types.js';
import { detectSkills } from '../skills/index.js';

// Compliance policy for the MCP_COMPLIANCE_MODE surface, which the OpenAI /
// Anthropic directories accept but the full one they reject: the isCompliant
// gate, COMPLIANT_SKILLS allowlist + visibleSkills filter, compliant descriptions.
export {
  CompliantAgentParamsSchema,
  COMPLIANT_AGENT_METHODS,
} from './schemas.js';

export const isCompliant = (config: McpConfig): boolean =>
  config.complianceMode === true;

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
  'Search the web using Browserless. Performs web searches via SearXNG ' +
  'and returns results from web, news, or images. Useful for research, ' +
  'gathering information, and finding relevant web pages.';

export const COMPLIANT_EXPORT_DESCRIPTION =
  'Export a webpage from a URL via the Browserless /export API. ' +
  'Fetches the URL and returns its content in the native format ' +
  '(HTML, PDF, image, etc.). Automatically detects the content type.';

export const COMPLIANT_SKILL_TOOL_DESCRIPTION = `Load a Browserless agent skill on demand.

Use this when you suspect the page exhibits a non-trivial mechanic but no SKILL block was auto-injected into a previous response. The auto-injection heuristics are conservative; calling this tool is the explicit fallback.

Available skills:
- **shadow-dom** — deep selectors, iframe URL-pattern syntax, what works through deep-ref
- **cookie-consent** — vendor-specific dismiss recipes (OneTrust, Cookiebot, Didomi, etc.)
- **modals** — close-button heuristics, ESC handling, alertdialog vs. dialog
- **snapshot-misses** — truncated/empty snapshots, image-rendered content
- **dynamic-content** — choosing the right \`wait*\` method after async triggers
- **screenshots** — when to screenshot vs. snapshot, scope and format choices
- **tabs** — multi-tab workflows, peek-without-switching`;
