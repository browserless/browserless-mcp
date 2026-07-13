import type { McpConfig, SkillId } from '../@types/types.js';
import { detectSkills } from '../skills/index.js';

// The compliant (directory-listable) surface. Serves the OpenAI + Anthropic app
// directories, whose policies reject the full surface (CAPTCHA solving,
// arbitrary code, residential/geo proxy, stealth, autologin, mass collection).
// Enabled per-process by MCP_COMPLIANCE_MODE; when off, the same process serves
// the full surface. This module owns the compliance policy: the `isCompliant`
// predicate, the COMPLIANT_SKILLS allowlist + `visibleSkills` filter, the
// compliant descriptions, and a re-export of the agent schema + allowed methods
// (built in schemas.js, where the command schemas live). Tools import the policy
// from here; the per-tool derivations (search/export `.pick` allowlists, the
// register.ts surface gate) live in their own modules and branch on `isCompliant`.
export {
  CompliantAgentParamsSchema,
  COMPLIANT_AGENT_METHODS,
} from './schemas.js';

export const isCompliant = (config: McpConfig): boolean =>
  config.complianceMode === true;

// ALLOWLIST of skills served on the compliant surface — fail-closed, mirroring
// the search/export `.pick` allowlists: a skill newly added to the registry does
// NOT auto-appear here; it must be added deliberately. Excludes captchas
// (circumvention) and autonomous-login/auth-profile (credential-driven login).
// Typed SkillId so a rename/removal of any listed id breaks the build.
export const COMPLIANT_SKILLS: ReadonlySet<SkillId> = new Set<SkillId>([
  'shadow-dom',
  'cookie-consent',
  'modals',
  'snapshot-misses',
  'dynamic-content',
  'screenshots',
  'tabs',
  'file-transfers',
]);

// Filter detected skill ids for the auto-injection path (see detectVisibleSkills
// in agent.ts): in compliant mode only allowlisted skills survive, so a
// restricted — or newly-added, not-yet-vetted — recipe never auto-injects into a
// reply. The skill enum is filtered off the same allowlist in agent.ts.
export const visibleSkills = (
  ids: ReadonlyArray<SkillId>,
  compliant: boolean,
): SkillId[] =>
  compliant ? ids.filter((id) => COMPLIANT_SKILLS.has(id)) : ids.slice();

// Compose detectSkills + visibleSkills for the agent auto-injection path. Lives
// here (not in agent.ts) so agent.ts imports only this filtered wrapper, not the
// raw detectSkills — an agent.ts auto-inject site can't silently bypass the
// compliant filter (a revert to detectSkills won't resolve there). detectSkills
// stays exported from skills/index.ts for its other callers.
export const detectVisibleSkills = (
  ctx: Parameters<typeof detectSkills>[0],
  state: Parameters<typeof detectSkills>[1],
  compliant: boolean,
): SkillId[] => visibleSkills(detectSkills(ctx, state), compliant);

export const COMPLIANT_AGENT_DESCRIPTION =
  'Drive a browser to complete a user-directed task on a page the user specifies: ' +
  'navigate, read, click, type, scroll, switch tabs, and screenshot. Use only for ' +
  'content the user is authorized to access. Do not use to bypass access controls ' +
  'or bot protection, solve CAPTCHAs, evade detection, route around IP/geo ' +
  "restrictions, or access content in violation of a site's terms of service. " +
  'Provide `commands` as a sequential batch; only the final result is returned.';

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
- **tabs** — multi-tab workflows, peek-without-switching
- **file-transfers** — \`uploadFile\` / \`getDownloads\`, stdio-path vs. base64 content, size caps`;
