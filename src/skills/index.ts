import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentError, SnapshotResult } from '../lib/agent-client.js';

export type SkillId =
  | 'shadow-dom'
  | 'cookie-consent'
  | 'modals'
  | 'captchas'
  | 'snapshot-misses'
  | 'dynamic-content'
  | 'screenshots';

const DEFAULT_MAX_ELEMENTS = 500;

export interface DetectContext {
  snapshot?: SnapshotResult;
  error?: AgentError;
  cmd?: { method: string; params: Record<string, unknown> };
  resp?: unknown;
  apiUrl?: string;
}

export interface SkillFireState {
  fired: Map<SkillId, number>;
  cmdIndex: number;
}

interface Skill {
  id: SkillId;
  path: string;
  body: string;
  detect: (ctx: DetectContext) => boolean;
  refireAfter?: number;
  cloudOnly?: boolean;
}

const skillsDir = dirname(fileURLToPath(import.meta.url));
const loadBody = (name: string): string =>
  readFileSync(join(skillsDir, name), 'utf-8');

const COOKIE_NAME_RE = /\b(accept all|reject all|consent|cookies?)\b/i;
const CAPTCHA_TEXT_RE =
  /\b(verify you are human|verifying you are human|i'?m not a robot|checking your browser|are you human|complete the (captcha|challenge))\b/i;
const CAPTCHA_HOST_RE =
  /(challenges\.cloudflare\.com|geo\.captcha-delivery\.com|hcaptcha\.com|recaptcha\.net|google\.com\/recaptcha)/i;
const CAPTCHA_ERROR_RE = /\b(captcha|cloudflare|challenge|forbidden|429|403)\b/i;
const CLOUD_API_HOSTS = ['production.browserless.io', 'chrome.browserless.io'];

const skills: Skill[] = [
  {
    id: 'shadow-dom',
    path: 'src/skills/shadow-dom.md',
    body: loadBody('shadow-dom.md'),
    refireAfter: 3,
    detect: ({ snapshot, error, cmd }) => {
      if (snapshot?.elements?.some((el) => el.selector?.startsWith('< '))) {
        return true;
      }
      const selector =
        typeof cmd?.params?.selector === 'string'
          ? cmd.params.selector
          : undefined;
      if (
        error?.code === 'SELECTOR_NOT_FOUND' &&
        selector &&
        !selector.startsWith('< ')
      ) {
        return true;
      }
      return false;
    },
  },
  {
    id: 'cookie-consent',
    path: 'src/skills/cookie-consent.md',
    body: loadBody('cookie-consent.md'),
    detect: ({ snapshot }) => {
      if (!snapshot?.elements) return false;
      return snapshot.elements.some((el) => {
        if (el.role !== 'button' && el.role !== 'link') return false;
        const name = el.name || el.text || '';
        return COOKIE_NAME_RE.test(name);
      });
    },
  },
  {
    id: 'modals',
    path: 'src/skills/modals.md',
    body: loadBody('modals.md'),
    detect: ({ snapshot }) => {
      if (!snapshot?.elements) return false;
      return snapshot.elements.some(
        (el) => el.role === 'dialog' || el.role === 'alertdialog',
      );
    },
  },
  {
    id: 'snapshot-misses',
    path: 'src/skills/snapshot-misses.md',
    body: loadBody('snapshot-misses.md'),
    detect: ({ snapshot, cmd }) => {
      if (!snapshot) return false;
      if (cmd?.method !== 'snapshot') return false;
      const len = snapshot.elements.length;
      if (len === 0) return true;
      const requestedMax =
        typeof cmd.params?.maxElements === 'number'
          ? cmd.params.maxElements
          : DEFAULT_MAX_ELEMENTS;
      return len >= requestedMax;
    },
  },
  {
    id: 'screenshots',
    path: 'src/skills/screenshots.md',
    body: loadBody('screenshots.md'),
    detect: ({ cmd }) => cmd?.method === 'screenshot',
  },
  {
    id: 'dynamic-content',
    path: 'src/skills/dynamic-content.md',
    body: loadBody('dynamic-content.md'),
    detect: ({ error, cmd }) => {
      if (!error || !cmd) return false;
      if (!cmd.method.startsWith('wait')) return false;
      return /timeout|timed out/i.test(error.message || '');
    },
  },
  {
    id: 'captchas',
    path: 'src/skills/captchas.md',
    body: loadBody('captchas.md'),
    cloudOnly: true,
    refireAfter: 3,
    detect: ({ snapshot, error, cmd }) => {
      if (snapshot?.url && CAPTCHA_HOST_RE.test(snapshot.url)) return true;
      if (
        snapshot?.elements?.some((el) => {
          const name = el.name || el.text || '';
          return CAPTCHA_TEXT_RE.test(name);
        })
      ) {
        return true;
      }
      if (
        cmd?.method === 'goto' &&
        error &&
        CAPTCHA_ERROR_RE.test(error.message || '')
      ) {
        return true;
      }
      return false;
    },
  },
];

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

export const detectSkills = (
  ctx: DetectContext,
  state: SkillFireState,
): SkillId[] => {
  const triggered: SkillId[] = [];
  for (const skill of skills) {
    if (skill.cloudOnly && !isCloudApi(ctx.apiUrl)) continue;
    if (!skill.detect(ctx)) continue;

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
