import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DetectContext,
  SkillFireState,
  SkillId,
} from '../@types/types.js';

const DEFAULT_MAX_ELEMENTS = 500;
const CLOUD_API_HOSTS = ['production.browserless.io', 'chrome.browserless.io'];

const COOKIE_NAME_RE = /\b(accept all|reject all|consent|cookies?)\b/i;
const CAPTCHA_TEXT_RE =
  /\b(verify you are human|verifying you are human|i'?m not a robot|checking your browser|are you human|complete the (captcha|challenge))\b/i;
const CAPTCHA_HOST_RE =
  /(challenges\.cloudflare\.com|geo\.captcha-delivery\.com|hcaptcha\.com|recaptcha\.net|google\.com\/recaptcha)/i;
const CAPTCHA_ERROR_RE =
  /\b(captcha|cloudflare|challenge|forbidden|429|403)\b/i;

const TAB_ERROR_CODES = ['TAB_NOT_FOUND', 'TAB_CLOSED', 'TAB_LIMIT_EXCEEDED'];
const TAB_COMMAND_METHODS = ['getTabs', 'switchTab', 'createTab', 'closeTab'];

/**
 * A single predicate evaluated against a DetectContext. Predicates compose
 * via Trigger (AND-clause) and SkillSpec.triggers (OR of AND-clauses).
 */
type Predicate =
  | {
      kind: 'snapshot.has-element';
      roles?: string[];
      nameRegex?: RegExp;
      selectorPrefix?: string;
    }
  | { kind: 'snapshot.has-input-type'; type: string }
  | { kind: 'snapshot.url-match'; regex: RegExp }
  | { kind: 'snapshot.has-detected-challenge' }
  | { kind: 'snapshot.tabs-at-least'; count: number }
  | { kind: 'snapshot.element-cap-hit' }
  | { kind: 'error.code'; codes: string[] }
  | { kind: 'error.message-match'; regex: RegExp }
  | { kind: 'command.method'; methods: string[] }
  | { kind: 'command.method-prefix'; prefix: string }
  | { kind: 'command.selector-not-deep' };

const evalPredicate = (p: Predicate, ctx: DetectContext): boolean => {
  switch (p.kind) {
    case 'snapshot.has-element': {
      const els = ctx.snapshot?.elements;
      if (!els) return false;
      return els.some((el) => {
        if (p.roles && !p.roles.includes(el.role)) return false;
        if (p.nameRegex) {
          const name = el.name || el.text || '';
          if (!p.nameRegex.test(name)) return false;
        }
        if (p.selectorPrefix && !el.selector?.startsWith(p.selectorPrefix)) {
          return false;
        }
        return true;
      });
    }
    case 'snapshot.has-input-type':
      return !!ctx.snapshot?.elements?.some((el) => el.type === p.type);
    case 'snapshot.url-match':
      return !!ctx.snapshot?.url && p.regex.test(ctx.snapshot.url);
    case 'snapshot.has-detected-challenge':
      return !!ctx.snapshot?.detectedChallenges?.length;
    case 'snapshot.tabs-at-least':
      return (ctx.snapshot?.tabs?.length ?? 0) >= p.count;
    case 'snapshot.element-cap-hit': {
      const snap = ctx.snapshot;
      const cmd = ctx.cmd;
      if (!snap || cmd?.method !== 'snapshot') return false;
      const len = snap.elements.length;
      if (len === 0) return true;
      const requestedMax =
        typeof cmd.params?.maxElements === 'number'
          ? cmd.params.maxElements
          : DEFAULT_MAX_ELEMENTS;
      return len >= requestedMax;
    }
    case 'error.code':
      return !!ctx.error?.code && p.codes.includes(ctx.error.code);
    case 'error.message-match':
      return !!ctx.error?.message && p.regex.test(ctx.error.message);
    case 'command.method':
      return !!ctx.cmd?.method && p.methods.includes(ctx.cmd.method);
    case 'command.method-prefix':
      return !!ctx.cmd?.method && ctx.cmd.method.startsWith(p.prefix);
    case 'command.selector-not-deep': {
      const sel = ctx.cmd?.params?.selector;
      return typeof sel === 'string' && !sel.startsWith('< ');
    }
  }
};

/** AND-clause: every predicate must match. */
type Trigger = Predicate[];

interface SkillSpec {
  id: SkillId;
  path: string;
  cloudOnly?: boolean;
  refireAfter?: number;
  /** OR of triggers; each trigger is an AND-clause of predicates. */
  triggers: Trigger[];
}

const SKILL_SPECS: SkillSpec[] = [
  {
    id: 'shadow-dom',
    path: 'src/skills/shadow-dom.md',
    refireAfter: 3,
    triggers: [
      // snapshot contains a deep-ref element
      [{ kind: 'snapshot.has-element', selectorPrefix: '< ' }],
      // selector-not-found error on a non-deep selector
      [
        { kind: 'error.code', codes: ['SELECTOR_NOT_FOUND'] },
        { kind: 'command.selector-not-deep' },
      ],
    ],
  },
  {
    id: 'cookie-consent',
    path: 'src/skills/cookie-consent.md',
    triggers: [
      [
        {
          kind: 'snapshot.has-element',
          roles: ['button', 'link'],
          nameRegex: COOKIE_NAME_RE,
        },
      ],
    ],
  },
  {
    id: 'modals',
    path: 'src/skills/modals.md',
    triggers: [
      [{ kind: 'snapshot.has-element', roles: ['dialog', 'alertdialog'] }],
    ],
  },
  {
    id: 'snapshot-misses',
    path: 'src/skills/snapshot-misses.md',
    triggers: [[{ kind: 'snapshot.element-cap-hit' }]],
  },
  {
    id: 'screenshots',
    path: 'src/skills/screenshots.md',
    triggers: [[{ kind: 'command.method', methods: ['screenshot'] }]],
  },
  {
    id: 'dynamic-content',
    path: 'src/skills/dynamic-content.md',
    triggers: [
      [
        { kind: 'command.method-prefix', prefix: 'wait' },
        { kind: 'error.message-match', regex: /timeout|timed out/i },
      ],
    ],
  },
  {
    id: 'tabs',
    path: 'src/skills/tabs.md',
    triggers: [
      [{ kind: 'snapshot.tabs-at-least', count: 2 }],
      [{ kind: 'error.code', codes: TAB_ERROR_CODES }],
      [{ kind: 'command.method', methods: TAB_COMMAND_METHODS }],
    ],
  },
  {
    id: 'autonomous-login',
    path: 'src/skills/autonomous-login.md',
    triggers: [
      [{ kind: 'snapshot.has-input-type', type: 'password' }],
    ],
  },
  {
    id: 'captchas',
    path: 'src/skills/captchas.md',
    cloudOnly: true,
    refireAfter: 3,
    triggers: [
      [{ kind: 'snapshot.has-detected-challenge' }],
      [{ kind: 'snapshot.url-match', regex: CAPTCHA_HOST_RE }],
      [{ kind: 'snapshot.has-element', nameRegex: CAPTCHA_TEXT_RE }],
      [
        { kind: 'command.method', methods: ['goto'] },
        { kind: 'error.message-match', regex: CAPTCHA_ERROR_RE },
      ],
    ],
  },
];

interface Skill extends SkillSpec {
  body: string;
}

const skillsDir = dirname(fileURLToPath(import.meta.url));
const loadBody = (filename: string): string =>
  readFileSync(join(skillsDir, filename), 'utf-8');

const skills: Skill[] = SKILL_SPECS.map((spec) => ({
  ...spec,
  body: loadBody(basename(spec.path)),
}));

export const skillsRegistry: ReadonlyArray<Skill> = skills;

export const isCloudApi = (apiUrl: string | undefined): boolean => {
  if (!apiUrl) return false;
  try {
    const host = new URL(apiUrl).hostname;
    return CLOUD_API_HOSTS.includes(host);
  } catch {
    return false;
  }
};

export const createSkillState = (): SkillFireState => ({
  fired: new Map(),
  cmdIndex: 0,
});

const fires = (skill: Skill, ctx: DetectContext): boolean =>
  skill.triggers.some((trigger) => trigger.every((p) => evalPredicate(p, ctx)));

export const detectSkills = (
  ctx: DetectContext,
  state: SkillFireState,
): SkillId[] => {
  const triggered: SkillId[] = [];
  for (const skill of skills) {
    if (skill.cloudOnly && !isCloudApi(ctx.apiUrl)) continue;
    if (!fires(skill, ctx)) continue;

    const lastFired = state.fired.get(skill.id);
    if (lastFired === undefined) {
      triggered.push(skill.id);
      continue;
    }
    if (
      skill.refireAfter !== undefined &&
      state.cmdIndex - lastFired >= skill.refireAfter
    ) {
      triggered.push(skill.id);
    }
  }
  return triggered;
};

export const markFired = (
  state: SkillFireState,
  ids: ReadonlyArray<SkillId>,
): void => {
  for (const id of ids) {
    state.fired.set(id, state.cmdIndex);
  }
};

export const renderSkill = (id: SkillId): string => {
  const skill = skills.find((s) => s.id === id);
  if (!skill) return '';
  return [
    `--- SKILL: ${skill.id} (${skill.path}) ---`,
    skill.body.trimEnd(),
    '--- END SKILL ---',
  ].join('\n');
};

export const renderSkills = (ids: ReadonlyArray<SkillId>): string =>
  ids.map(renderSkill).filter(Boolean).join('\n\n');
