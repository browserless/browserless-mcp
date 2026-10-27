import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sinon from 'sinon';
import { FastMCP, type Content } from 'fastmcp';
import { z } from 'zod';
import { clearSession } from '../../src/lib/download-store.js';
import { registerSurface } from '../../src/tools/register.js';
import { registerStatusResource } from '../../src/resources/status.js';
import {
  announceToolListOnConnect,
  COMPLIANT_EXPORT_DESCRIPTION,
  COMPLIANT_MAP_DESCRIPTION,
  COMPLIANT_PERFORMANCE_DESCRIPTION,
  COMPLIANT_SEARCH_DESCRIPTION,
  READ_PAGE_DESCRIPTION,
  visibleSkills,
  detectVisibleSkills,
  COMPLIANT_SKILLS,
  COMPLIANT_AGENT_METHODS,
} from '../../src/tools/compliance.js';
import {
  createSkillState,
  skillsRegistry,
  renderSkill,
  validateMarkers,
} from '../../src/skills/index.js';
import {
  buildSurfaceExtras,
  registerAgentTools,
} from '../../src/tools/agent.js';
import {
  hydrateRemoteSkills,
  __resetRemoteSkillsForTesting,
} from '../../src/skills/sites.js';
import { COMPLIANT_AGENT_SYSTEM_PROMPT } from '../../src/skills/system-prompt.js';
import type { McpConfig, SkillId } from '../../src/@types/types.js';

const baseConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  oauthRegisterRateLimitPerHour: 300,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

type CapturedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};

// Drive the REAL registration seam (src/tools/register.ts, which index.ts also
// calls) so this guard catches drift — e.g. a new circumvention tool registered
// unconditionally would change the compliant tool set and fail here.
function captureTools(
  complianceMode: boolean,
  transport: McpConfig['transport'] = 'stdio',
) {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const toolSpy = sinon.spy(server, 'addTool');
  const promptSpy = sinon.spy(server, 'addPrompt');
  const resourceSpy = sinon.spy(server, 'addResource');
  const config: McpConfig = { ...baseConfig, complianceMode, transport };

  registerSurface(server, config);

  const calls = toolSpy
    .getCalls()
    .map((c) => c.args[0] as unknown as CapturedTool);
  return {
    names: calls.map((t) => t.name).sort(),
    byName: new Map(calls.map((t) => [t.name, t])),
    promptNames: promptSpy
      .getCalls()
      .map((c) => (c.args[0] as { name: string }).name)
      .sort(),
    resourceUris: resourceSpy
      .getCalls()
      .map((c) => (c.args[0] as { uri: string }).uri)
      .sort(),
  };
}

function captureAgentTools(complianceMode: boolean) {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const spy = sinon.spy(server, 'addTool');
  registerAgentTools(server, { ...baseConfig, complianceMode });
  const tools = spy.getCalls().map((c) => c.args[0] as unknown as CapturedTool);
  return { byName: new Map(tools.map((tool) => [tool.name, tool])) };
}

const VALID_GOTO = { method: 'goto', params: { url: 'https://example.com' } };

describe('compliance mode — compliant tool surface', () => {
  afterEach(() => sinon.restore());

  describe('reply block layout', () => {
    const cases = [
      {
        name: 'performance',
        params: { url: 'https://example.com', categories: ['performance'] },
        response: {
          type: 'json',
          data: {
            categories: { performance: { title: 'Performance', score: 0.87 } },
            audits: { 'largest-contentful-paint': { displayValue: '2.3 s' } },
          },
        },
        parts: [
          '## Lighthouse Scores',
          '- Performance: 87/100',
          '## Lighthouse Lab Metrics',
          '- LCP: 2.3 s',
          'INP is not measured',
          'URL: https://example.com',
        ],
        fullBlocks: 4,
      },
      {
        name: 'search',
        params: { query: 'browser news', sources: ['web', 'news'] },
        response: {
          success: true,
          totalResults: 2,
          data: {
            web: [
              {
                title: 'Web match',
                url: 'https://example.com/web',
                description: 'Web snippet',
              },
            ],
            news: [
              {
                title: 'News match',
                url: 'https://example.com/news',
                description: 'News snippet',
              },
            ],
          },
        },
        parts: [
          '## Web Results',
          'Web match',
          'Web snippet',
          '## News Results',
          'News match',
          'News snippet',
          'Query: browser news',
        ],
        fullBlocks: 3,
      },
      {
        name: 'map',
        params: { url: 'https://example.com' },
        response: {
          success: true,
          links: [{ url: 'https://example.com/about', title: 'About title' }],
        },
        parts: [
          '## Site Map Results',
          'About title',
          '## URL List',
          'https://example.com/about',
          'Base URL: https://example.com',
        ],
        fullBlocks: 3,
      },
      {
        name: 'export',
        params: { url: 'https://example.com' },
        response: '<p>Exported content</p>',
        parts: [
          '<p>Exported content</p>',
          'URL: https://example.com',
          'Content-Type: text/html',
        ],
        fullBlocks: 2,
      },
    ];

    for (const compliant of [true, false]) {
      for (const fixture of cases) {
        it(`${fixture.name} preserves every section in order on ${compliant ? 'one connector block' : 'full multi-block replies'}`, async () => {
          sinon.stub(globalThis, 'fetch').resolves(
            new Response(
              typeof fixture.response === 'string'
                ? fixture.response
                : JSON.stringify(fixture.response),
              {
                headers: {
                  'Content-Type':
                    fixture.name === 'export'
                      ? 'text/html'
                      : 'application/json',
                },
              },
            ),
          );
          const context = {
            reportProgress: sinon.stub().resolves(),
            log: {
              debug: sinon.stub(),
              info: sinon.stub(),
              warn: sinon.stub(),
              error: sinon.stub(),
            },
            sessionId: 'reply-layout-test',
          };
          try {
            const tool = captureTools(compliant).byName.get(
              `browserless_${fixture.name}`,
            )!;
            const result = (await tool.execute(fixture.params, context)) as {
              content: Content[];
            };
            expect(result.content).to.have.length(
              compliant ? 1 : fixture.fullBlocks,
            );
            expect(
              result.content.every((block) => block.type === 'text'),
            ).to.equal(true);
            const text = result.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('\n\n');
            let previous = -1;
            for (const part of fixture.parts) {
              const index = text.indexOf(part, previous + 1);
              expect(index, part).to.be.greaterThan(previous);
              previous = index;
            }
          } finally {
            clearSession(context.sessionId);
          }
        });
      }
    }
  });

  it('registers exactly the five connector tools', () => {
    const { names } = captureTools(true);
    expect(names).to.deep.equal([
      'browserless_export',
      'browserless_map',
      'browserless_performance',
      'browserless_read_page',
      'browserless_search',
    ]);
  });

  it('full stdio mode registers exactly the 18 tools (regression guard)', () => {
    const { names } = captureTools(false);
    expect(names).to.deep.equal([
      'browserless_account',
      'browserless_agent',
      'browserless_crawl',
      'browserless_export',
      'browserless_function',
      'browserless_link_checkout',
      'browserless_link_connect',
      'browserless_live_url',
      'browserless_logs',
      'browserless_map',
      'browserless_performance',
      'browserless_profiles',
      'browserless_read_page',
      'browserless_search',
      'browserless_sessions',
      'browserless_skill',
      'browserless_smartscraper',
      'browserless_usage',
    ]);
  });

  it('browserless_profiles is full-only (excluded from the compliant surface)', () => {
    expect(captureTools(true).byName.has('browserless_profiles')).to.be.false;
    expect(captureTools(false).byName.has('browserless_profiles')).to.be.true;
  });

  it('Stripe Link tools are full-only', () => {
    const compliant = captureTools(true).byName;
    const full = captureTools(false).byName;
    expect(compliant.has('browserless_link_connect')).to.be.false;
    expect(compliant.has('browserless_link_checkout')).to.be.false;
    expect(full.has('browserless_link_connect')).to.be.true;
    expect(full.has('browserless_link_checkout')).to.be.true;
  });

  it('full HTTP adds stage_file for exactly 19 tools', () => {
    const stdio = captureTools(false).names;
    const http = captureTools(false, 'httpStream').names;
    expect(http).to.have.length(19);
    expect(http).to.deep.equal([...stdio, 'browserless_stage_file'].sort());
  });

  it('search and map are on both surfaces', () => {
    for (const mode of [true, false]) {
      expect(captureTools(mode).names).to.include.members([
        'browserless_search',
        'browserless_map',
      ]);
    }
  });

  it('agent, skill, account, usage, sessions and logs are full-only', () => {
    const compliant = captureTools(true).names;
    const full = captureTools(false).names;
    for (const name of [
      'agent',
      'skill',
      'account',
      'usage',
      'sessions',
      'logs',
    ]) {
      expect(compliant).not.to.include(`browserless_${name}`);
      expect(full).to.include(`browserless_${name}`);
    }
  });

  // #179 broke compliance by re-adding direct register*() calls in index.ts,
  // bypassing the registerSurface gate (the register.ts-driven tests above can't
  // see that). Lock index.ts to registerSurface as the sole registration path.
  it('index.ts registers the surface only via registerSurface (no direct tool calls)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
    // A register*Tool/Resource/Prompt call in index.ts bypasses the registerSurface
    // gate (how #179 regressed); generic match catches any new tool, not a fixed list.
    const directCalls = [
      ...src.matchAll(/\bregister\w+(?:Tools?|Resource|Prompt)\s*\(/g),
    ].map((m) => m[0]);
    expect(
      directCalls,
      'register via registerSurface, not directly in index.ts',
    ).to.deep.equal([]);
    expect(src, 'index.ts must call registerSurface').to.include(
      'registerSurface(',
    );
  });

  describe('non-tool surface (prompts + resources)', () => {
    it('compliant mode has no prompts or resources', () => {
      const { promptNames, resourceUris } = captureTools(true);
      expect(promptNames).to.deep.equal([]);
      expect(resourceUris).to.deep.equal([]);
    });

    it('full mode serves the prompts + api-docs resource', () => {
      const { promptNames, resourceUris } = captureTools(false);
      expect(promptNames).to.include.members(['scrape-url', 'extract-content']);
      expect(resourceUris).to.include.members([
        'browserless://api-docs',
        'browserless://status',
      ]);
    });
  });

  describe('tool-list announcements', () => {
    for (const complianceMode of [true, false]) {
      it(`${complianceMode ? 'connector suppresses' : 'full sends'} the connect announcement`, () => {
        const session = {
          triggerListChangedNotification: sinon.stub().resolves(),
        };
        announceToolListOnConnect(session, { ...baseConfig, complianceMode });
        if (complianceMode) {
          sinon.assert.notCalled(session.triggerListChangedNotification);
        } else {
          sinon.assert.calledOnceWithExactly(
            session.triggerListChangedNotification,
            'notifications/tools/list_changed',
          );
        }
      });
    }

    it('index.ts delegates connect announcements to the compliance helper', () => {
      const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
      expect(src).to.match(/\bannounceToolListOnConnect\s*\(/);
      expect(src).not.to.match(/\btriggerListChangedNotification\s*\(/);
    });
  });

  describe('agent schema', () => {
    it('accepts a navigation command batch', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      expect(agent.parameters.safeParse({ commands: [VALID_GOTO] }).success).to
        .be.true;
    });

    it('accepts capability requirements', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      expect(
        agent.parameters.safeParse({
          commands: [VALID_GOTO],
          requiredCapabilities: ['vision'],
        }).success,
      ).to.be.true;
    });

    it('rejects an empty or missing commands array', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      expect(
        agent.parameters.safeParse({ commands: [] }).success,
        'empty commands',
      ).to.be.false;
      expect(
        agent.parameters.safeParse({ rationale: 'x' }).success,
        'missing commands',
      ).to.be.false;
    });

    it('rejects prohibited commands (solve/evaluate/loadSecret/clearSecrets/saveSecret)', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      for (const method of [
        'solve',
        'evaluate',
        'loadSecret',
        'clearSecrets',
        'saveSecret',
      ]) {
        expect(
          agent.parameters.safeParse({ commands: [{ method, params: {} }] })
            .success,
          `method ${method} must be rejected`,
        ).to.be.false;
      }
    });

    it('full mode accepts solve and evaluate (they are removed only in compliant)', () => {
      const full = captureAgentTools(false).byName.get('browserless_agent')!;
      expect(
        full.parameters.safeParse({ commands: [{ method: 'solve' }] }).success,
        'full accepts solve',
      ).to.be.true;
      expect(
        full.parameters.safeParse({
          commands: [{ method: 'evaluate', params: { content: '1+1' } }],
        }).success,
        'full accepts evaluate',
      ).to.be.true;
    });

    it('compliant rejects an unknown method (no raw-BQL passthrough arm)', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      expect(
        agent.parameters.safeParse({
          commands: [{ method: 'totally-unknown-method', params: {} }],
        }).success,
      ).to.be.false;
    });

    it('COMPLIANT_AGENT_METHODS is an EXACT allowlist (a new prohibited command added to the compliant union fails here)', () => {
      // Mirrors the top-level EXPECTED_KEYS guard for the command-method
      // dimension: navigation + read + interaction (click/type/select/etc. are
      // legitimate automation, not circumvention); the prohibited classes —
      // solve/evaluate/loadSecret/clearSecrets/saveSecret and proxy/profile stay out.
      const EXPECTED_METHODS = [
        'goto',
        'back',
        'forward',
        'reload',
        'snapshot',
        'getTabs',
        'switchTab',
        'createTab',
        'closeTab',
        'click',
        'type',
        'select',
        'checkbox',
        'hover',
        'scroll',
        'text',
        'html',
        'waitForSelector',
        'waitForNavigation',
        'waitForTimeout',
        'waitForRequest',
        'waitForResponse',
        'liveURL',
        'screenshot',
        'reportOutcome',
        'close',
      ];
      expect([...COMPLIANT_AGENT_METHODS]).to.have.members(EXPECTED_METHODS);
      expect(COMPLIANT_AGENT_METHODS.size).to.equal(EXPECTED_METHODS.length);
    });

    it('rejects proxy / profile / createProfile / raw method passthrough (strict)', () => {
      const agent = captureAgentTools(true).byName.get('browserless_agent')!;
      expect(
        agent.parameters.safeParse({ commands: [VALID_GOTO], proxy: {} })
          .success,
      ).to.be.false;
      // profile hydrates a saved auth session — no auth-profile capability on
      // the compliant surface (parity with the hidden auth-profile skill).
      expect(
        agent.parameters.safeParse({
          commands: [VALID_GOTO],
          profile: 'my-profile',
        }).success,
        'profile must be rejected',
      ).to.be.false;
      for (const extra of [
        { emulationOs: 'windows' },
        { emulatedDevice: 'pixel-8' },
        { screen: '1920x1080' },
        { deviceScaleFactor: 1 },
        { deviceSlot: 0 },
        { proxy: { proxy: 'datacenter' } },
      ]) {
        expect(
          agent.parameters.safeParse({ commands: [VALID_GOTO], ...extra })
            .success,
          JSON.stringify(extra),
        ).to.be.false;
      }
      expect(
        agent.parameters.safeParse({
          commands: [VALID_GOTO],
          createProfile: {},
        }).success,
      ).to.be.false;
      expect(
        agent.parameters.safeParse({
          method: 'goto',
          params: { url: 'https://example.com' },
        }).success,
      ).to.be.false;
    });

    it('full mode accepts profile (auth-profile capability removed only in compliant)', () => {
      const full = captureAgentTools(false).byName.get('browserless_agent')!;
      expect(
        full.parameters.safeParse({
          commands: [VALID_GOTO],
          profile: 'my-profile',
        }).success,
      ).to.be.true;
    });
  });

  describe('skill tool', () => {
    it('enum excludes authentication and captcha skills, keeps others', () => {
      const skill = captureAgentTools(true).byName.get('browserless_skill')!;
      for (const id of [
        'captchas',
        'autonomous-login',
        'autonomous-registration',
        'auth-profile',
        'profile-import',
      ]) {
        expect(
          skill.parameters.safeParse({ id }).success,
          `skill ${id} must be rejected`,
        ).to.be.false;
      }
      expect(skill.parameters.safeParse({ id: 'shadow-dom' }).success).to.be
        .true;
    });

    it('enum is an EXACT allowlist: every registry skill accepted iff in the approved eight', () => {
      // Independent oracle — the approved eight hardcoded here, NOT derived from
      // COMPLIANT_SKILLS (which also feeds the enum). An accidental expansion of
      // COMPLIANT_SKILLS would otherwise move both sides in lockstep and pass;
      // pinning to this literal makes it fail instead.
      const APPROVED = [
        'shadow-dom',
        'cookie-consent',
        'modals',
        'snapshot-misses',
        'dynamic-content',
        'screenshots',
        'vision-fallback',
        'tabs',
      ];
      expect(
        [...COMPLIANT_SKILLS].sort(),
        'COMPLIANT_SKILLS drifted from the approved eight',
      ).to.deep.equal([...APPROVED].sort());

      // Fail-closed lock: the schema accepts a registry skill iff it's approved
      // (a denylist would let an un-classified skill through by default).
      const approved = new Set(APPROVED);
      const skill = captureAgentTools(true).byName.get('browserless_skill')!;
      for (const s of skillsRegistry) {
        expect(
          skill.parameters.safeParse({ id: s.id }).success,
          `skill ${s.id}: accepted iff approved`,
        ).to.equal(approved.has(s.id));
      }
    });

    it('description does not advertise captchas or autonomous-login', () => {
      const skill = captureAgentTools(true).byName.get('browserless_skill')!;
      expect(skill.description).to.not.match(/captchas|autonomous-login/i);
    });

    it('description lists exactly the allowlisted skills (guards prose drift)', () => {
      const desc =
        captureAgentTools(true).byName.get('browserless_skill')!.description;
      for (const id of COMPLIANT_SKILLS) {
        expect(desc, `description must mention ${id}`).to.contain(id);
      }
      // Every non-compliant skill must be absent — catches a skill dropped from
      // COMPLIANT_SKILLS but left in the hand-kept prose (which would then lie).
      for (const s of skillsRegistry) {
        if (!COMPLIANT_SKILLS.has(s.id)) {
          expect(desc, `description must not mention ${s.id}`).to.not.contain(
            s.id,
          );
        }
      }
    });

    it('agent system prompt lists exactly the allowlisted skills (guards prompt drift)', () => {
      // The de-fanged agent prompt hand-maintains the same skill list as
      // COMPLIANT_SKILL_TOOL_DESCRIPTION. Guard it the same way so a skill
      // added to / removed from COMPLIANT_SKILLS can't silently desync it.
      for (const id of COMPLIANT_SKILLS) {
        expect(
          COMPLIANT_AGENT_SYSTEM_PROMPT,
          `prompt must mention ${id}`,
        ).to.contain(id);
      }
      for (const s of skillsRegistry) {
        if (!COMPLIANT_SKILLS.has(s.id)) {
          expect(
            COMPLIANT_AGENT_SYSTEM_PROMPT,
            `prompt must not mention ${s.id}`,
          ).to.not.contain(s.id);
        }
      }
    });

    it('full mode keeps the excluded skills selectable (regression guard)', () => {
      const skill = captureAgentTools(false).byName.get('browserless_skill')!;
      expect(skill.parameters.safeParse({ id: 'captchas' }).success).to.be.true;
    });

    it('compliant drops the `site` recipe lookup (strict); full keeps it', () => {
      const conn = captureAgentTools(true).byName.get('browserless_skill')!;
      const full = captureAgentTools(false).byName.get('browserless_skill')!;
      // compliant schema exposes only `id` — no `site` recipe param advertised
      const shape = (
        conn.parameters as unknown as { shape?: Record<string, unknown> }
      ).shape;
      expect(Object.keys(shape ?? {})).to.deep.equal(['id']);
      // and rejects a `site` arg outright (strict)
      expect(conn.parameters.safeParse({ site: 'ebay.com' }).success).to.be
        .false;
      expect(
        conn.parameters.safeParse({ id: 'shadow-dom', site: 'ebay.com' })
          .success,
        'stray site rejected even with a valid id',
      ).to.be.false;
      // full resolves site recipes
      expect(full.parameters.safeParse({ site: 'ebay.com' }).success).to.be
        .true;
    });
  });

  describe('descriptions and dropped params', () => {
    it('smartscraper is absent in compliant mode, present in full', () => {
      expect(captureTools(true).byName.has('browserless_smartscraper')).to.be
        .false;
      expect(captureTools(false).byName.has('browserless_smartscraper')).to.be
        .true;
    });

    it('export rejects includeResources (strict); full keeps it', () => {
      const conn = captureTools(true).byName.get('browserless_export')!;
      const full = captureTools(false).byName.get('browserless_export')!;
      const withRes = { url: 'https://example.com', includeResources: true };
      expect(conn.parameters.safeParse(withRes).success, 'compliant rejects').to
        .be.false;
      expect(
        conn.parameters.safeParse({ url: 'https://example.com' }).success,
        'compliant accepts without it',
      ).to.be.true;
      expect(full.parameters.safeParse(withRes).success, 'full keeps it').to.be
        .true;
    });

    it('export rejects profile / auth-session hydration (strict); full keeps it', () => {
      const conn = captureTools(true).byName.get('browserless_export')!;
      const full = captureTools(false).byName.get('browserless_export')!;
      const withProfile = { url: 'https://example.com', profile: 'my-profile' };
      expect(
        conn.parameters.safeParse(withProfile).success,
        'compliant rejects',
      ).to.be.false;
      expect(full.parameters.safeParse(withProfile).success, 'full keeps it').to
        .be.true;
    });

    it('performance rejects profile / auth-session hydration (strict); full keeps it', () => {
      const conn = captureTools(true).byName.get('browserless_performance')!;
      const full = captureTools(false).byName.get('browserless_performance')!;
      const withProfile = { url: 'https://example.com', profile: 'my-profile' };
      expect(
        conn.parameters.safeParse(withProfile).success,
        'compliant rejects',
      ).to.be.false;
      expect(full.parameters.safeParse(withProfile).success, 'full keeps it').to
        .be.true;
    });

    it('serves the de-fanged compliant descriptions (what a directory reviewer reads)', () => {
      const { byName } = captureTools(true);
      // agent: explicit restrictive posture
      expect(
        captureAgentTools(true).byName.get('browserless_agent')!.description,
      ).to.match(/do not use to bypass access controls/i);
      // export: no bulk-asset / ZIP language
      expect(byName.get('browserless_export')!.description).to.not.match(
        /zip|bundle all|includeResources/i,
      );
    });
  });

  describe('run()-layer defense-in-depth (schema bypass)', () => {
    const mockCtx = {
      reportProgress: sinon.stub().resolves(),
      log: {
        debug: sinon.stub(),
        error: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
      },
      session: undefined,
      streamContent: sinon.stub().resolves(),
      elicit: sinon.stub().resolves({ action: 'cancel' }),
    };

    // Bypasses schema validation by calling execute() directly — the "schema
    // mis-built" case the allowlist loop exists for and safeParse can't reach.
    const compliantAgentExecute = () => {
      return captureAgentTools(true).byName.get('browserless_agent')!.execute;
    };

    it('rejects an unknown (non-allowlisted) method even when the schema is bypassed', async () => {
      // Unknown, not a known-prohibited method: a denylist would let this
      // through, so accepting it would prove the run-layer guard is not the
      // allowlist it claims to be. (evaluate is covered by the batch-index test
      // below and the schema-level test above.)
      const execute = compliantAgentExecute();
      try {
        await execute(
          { commands: [{ method: 'totally-unknown-method', params: {} }] },
          mockCtx,
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    it('rejects a prohibited method at a NON-ZERO batch index (checks every command)', async () => {
      const execute = compliantAgentExecute();
      try {
        // evaluate at index 1 — a loop that only checked commands[0] would leak.
        await execute(
          {
            commands: [
              { method: 'goto', params: { url: 'https://example.com' } },
              { method: 'evaluate', params: { content: '1' } },
            ],
          },
          mockCtx,
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    it('rejects an empty/absent method (no bare passthrough)', async () => {
      const execute = compliantAgentExecute();
      try {
        await execute({}, mockCtx);
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    it('rejects proxy / auth profile / createProfile even when the schema is bypassed', async () => {
      const execute = compliantAgentExecute();
      for (const extra of [
        { profile: 'my-profile' },
        { createProfile: { name: 'x' } },
        { proxy: { proxy: 'residential', proxyCountry: 'us' } },
        { proxy: { proxy: 'datacenter' } },
        { emulationOs: 'windows' },
        { emulatedDevice: 'pixel-8' },
        { screen: '1920x1080' },
        { deviceScaleFactor: 1 },
        { deviceSlot: 0 },
      ]) {
        try {
          await execute({ commands: [VALID_GOTO], ...extra }, mockCtx);
          expect.fail(`expected UserError for ${JSON.stringify(extra)}`);
        } catch (err) {
          expect((err as Error).message).to.match(/not available/i);
        }
      }
    });

    const compliantSkillExecute = () => {
      return captureAgentTools(true).byName.get('browserless_skill')!.execute;
    };

    it('skill run() refuses a restricted recipe even when the enum is bypassed', async () => {
      const execute = compliantSkillExecute();
      try {
        await execute({ id: 'captchas' }, mockCtx);
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    const compliantExecute = (toolName: string) => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const spy = sinon.spy(server, 'addTool');
      registerSurface(server, { ...baseConfig, complianceMode: true });
      return spy.getCalls().find((c) => c.args[0].name === toolName)!
        .args[0] as {
        execute: (a: unknown, c: unknown) => Promise<unknown>;
      };
    };

    it('export run() rejects includeResources even when the schema is bypassed', async () => {
      const { execute } = compliantExecute('browserless_export');
      try {
        await execute(
          { url: 'https://example.com', includeResources: true },
          mockCtx,
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    it('export run() rejects an auth profile even when the schema is bypassed', async () => {
      const { execute } = compliantExecute('browserless_export');
      try {
        await execute(
          { url: 'https://example.com', profile: 'my-profile' },
          mockCtx,
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });

    it('performance run() rejects an auth profile even when the schema is bypassed', async () => {
      const { execute } = compliantExecute('browserless_performance');
      try {
        await execute(
          { url: 'https://example.com', profile: 'my-profile' },
          mockCtx,
        );
        expect.fail('expected UserError');
      } catch (err) {
        expect((err as Error).message).to.match(/not available/i);
      }
    });
  });

  describe('compliant tool schemas are exact allowlists (drift guard)', () => {
    // Exact top-level key-set per tool — NOT a forbidden-name denylist. A future
    // edit that adds ANY top-level field (evasion or not, any name) to a
    // compliant tool fails here, regardless of what it's called.
    const EXPECTED_KEYS: Record<string, string[]> = {
      browserless_export: [
        'bestAttempt',
        'gotoOptions',
        'timeout',
        'url',
        'waitForTimeout',
      ],
      browserless_performance: ['categories', 'device', 'timeout', 'url'],
      browserless_search: [
        'categories',
        'country',
        'lang',
        'limit',
        'location',
        'query',
        'sources',
        'tbs',
        'timeout',
      ],
      browserless_map: [
        'ignoreQueryParameters',
        'includeSubdomains',
        'limit',
        'search',
        'sitemap',
        'timeout',
        'url',
      ],
      browserless_read_page: [
        'format',
        'selector',
        'url',
        'waitForSelector',
        'waitForTimeout',
      ],
    };

    it('each compliant tool exposes exactly its expected top-level keys', () => {
      const { byName } = captureTools(true);
      expect([...byName.keys()].sort(), 'compliant tool set').to.deep.equal(
        Object.keys(EXPECTED_KEYS).sort(),
      );
      for (const [name, tool] of byName) {
        const shape = (
          tool.parameters as unknown as { shape?: Record<string, unknown> }
        ).shape;
        // Fail loudly if a schema is ever wrapped (e.g. ZodEffects with no
        // `.shape`), so the guard can't silently go vacuous.
        expect(shape, `${name} schema must be introspectable (a ZodObject)`).to
          .not.be.undefined;
        expect(
          Object.keys(shape ?? {}).sort(),
          `${name} top-level keys`,
        ).to.deep.equal(EXPECTED_KEYS[name]);
      }
    });

    it('export gotoOptions exposes exactly timeout and waitUntil', () => {
      const tool = captureTools(true).byName.get('browserless_export')!;
      const schema = z.toJSONSchema(tool.parameters);
      const gotoOptions = schema.properties
        ?.gotoOptions as z.core.JSONSchema.BaseSchema;
      expect(gotoOptions).to.be.an('object');
      expect(Object.keys(gotoOptions.properties ?? {}).sort()).to.deep.equal([
        'timeout',
        'waitUntil',
      ]);
    });

    it('no connector tool has an untyped object field', () => {
      const visit = (node: unknown, path: string): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          expect(key, path).not.to.equal('propertyNames');
          if (key === 'additionalProperties')
            expect(value, path).to.equal(false);
          visit(value, `${path}.${key}`);
        }
      };
      for (const [name, tool] of captureTools(true).byName) {
        visit(z.toJSONSchema(tool.parameters), name);
      }
    });

    it('connector descriptions equal their constants and schemas contain no forbidden copy', () => {
      const descriptions: Record<string, string> = {
        browserless_export: COMPLIANT_EXPORT_DESCRIPTION,
        browserless_map: COMPLIANT_MAP_DESCRIPTION,
        browserless_performance: COMPLIANT_PERFORMANCE_DESCRIPTION,
        browserless_read_page: READ_PAGE_DESCRIPTION,
        browserless_search: COMPLIANT_SEARCH_DESCRIPTION,
      };
      const { byName } = captureTools(true);
      expect([...byName.keys()].sort()).to.deep.equal(
        Object.keys(descriptions).sort(),
      );
      for (const [name, tool] of byName) {
        expect(tool.description, name).to.equal(descriptions[name]);
        const copy =
          tool.description + JSON.stringify(z.toJSONSchema(tool.parameters));
        expect(copy, name).not.to.match(
          /SearXNG|Puppeteer|\/export API|\/performance API|crawl|stdio|curl|download|upgrade|pricing|\bplan\b/i,
        );
      }
    });

    // Cross-tool invariant: the compliant surface exposes ZERO auth-profile
    // capability. A `profile` param hydrates a saved session's cookies/
    // localStorage (see profileField) — auth-session injection a directory
    // reviewer would flag. No compliant tool may expose it on any surface.
    it('no compliant tool exposes a `profile` (auth-session) parameter', () => {
      const { byName } = captureTools(true);
      for (const [name, tool] of byName) {
        const shape = (
          tool.parameters as unknown as { shape?: Record<string, unknown> }
        ).shape;
        expect(
          Object.keys(shape ?? {}),
          `${name} must not expose profile`,
        ).to.not.include('profile');
      }
    });
  });

  describe('status resource reports the active surface', () => {
    // Load the status resource via its no-token early-return branch (no network),
    // and assert the machine-readable `surface` attestation a directory/uptime
    // check reads. Guards an inverted ternary or a dropped field.
    const loadStatus = async (complianceMode: boolean) => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const spy = sinon.spy(server, 'addResource');
      registerStatusResource(server, {
        ...baseConfig,
        browserlessToken: undefined,
        complianceMode,
      });
      const res = spy
        .getCalls()
        .find((c) => c.args[0].uri === 'browserless://status')!.args[0] as {
        load: () => Promise<{ text: string }>;
      };
      return JSON.parse((await res.load()).text);
    };

    it('reports surface "compliant" in compliant mode', async () => {
      expect((await loadStatus(true)).surface).to.equal('compliant');
    });

    it('reports surface "full" in full mode', async () => {
      expect((await loadStatus(false)).surface).to.equal('full');
    });
  });

  // Guards the skill AUTO-INJECTION path: even when detectSkills fires for a
  // restricted recipe, visibleSkills must strip it in compliant mode so the
  // recipe never lands in an agent reply. Full mode must keep every id.
  describe('visibleSkills (auto-injection filter)', () => {
    const triggered = [
      'captchas',
      'shadow-dom',
      'autonomous-login',
      'modals',
      'auth-profile',
    ] as SkillId[];

    it('strips every restricted recipe in compliant mode', () => {
      const out = visibleSkills(triggered, true);
      expect(out).to.deep.equal(['shadow-dom', 'modals']);
      for (const restricted of [
        'captchas',
        'autonomous-login',
        'auth-profile',
      ]) {
        expect(out).to.not.include(restricted);
      }
    });

    it('passes every id through in full mode', () => {
      expect(visibleSkills(triggered, false)).to.deep.equal(triggered);
    });

    // Wiring guard: the leak path is a restricted recipe AUTO-FIRING on an
    // allowed command (a login-page snapshot fires autonomous-login), which the
    // enum/allowlist never see. detectVisibleSkills composes detectSkills +
    // visibleSkills; if the compose is dropped, the recipe re-appears here.
    const loginCtx = {
      snapshot: { url: 'https://example.com/login', elements: [] },
    } as unknown as Parameters<typeof detectVisibleSkills>[0];

    it('full mode auto-injects autonomous-login on a login page', () => {
      expect(
        detectVisibleSkills(loginCtx, createSkillState(), false),
      ).to.include('autonomous-login');
    });

    it('compliant mode strips the auto-fired autonomous-login recipe', () => {
      expect(
        detectVisibleSkills(loginCtx, createSkillState(), true),
      ).to.not.include('autonomous-login');
    });
  });

  describe('compliant skill BODIES are de-fanged', () => {
    it('no allowlisted skill renders evaluate/captcha content in compliant mode', () => {
      for (const id of COMPLIANT_SKILLS) {
        const body = renderSkill(id, true);
        expect(body, `${id} must not advise \`evaluate\``).to.not.match(
          /\bevaluate\b/i,
        );
        expect(body, `${id} must not list captcha selectors`).to.not.match(
          /recaptcha|hcaptcha|turnstile|captcha/i,
        );
        expect(body, `${id} marker comments must be stripped`).to.not.match(
          /compliant-(omit|only)/,
        );
        expect(body, `${id} still renders`).to.contain(`SKILL: ${id}`);
      }
    });

    it('full mode retains the omitted content and strips both markers', () => {
      const full = renderSkill('shadow-dom', false);
      expect(full, 'full keeps evaluate guidance').to.match(/\bevaluate\b/);
      expect(full, 'markers never leak to output').to.not.match(
        /compliant-(omit|only)/,
      );
    });

    // Cutting the omitted path must not leave a listed problem with no remedy:
    // the compliant-only block supplies the reduced-surface replacement. Assert
    // it appears ONLY in compliant, so a revert of either marker is caught.
    it('supplies compliant-only replacement guidance for the omitted paths', () => {
      const cases: ReadonlyArray<[SkillId, RegExp]> = [
        ['snapshot-misses', /read the answer visually/i],
        ['shadow-dom', /for interaction, not reading/i],
      ];
      for (const [id, prose] of cases) {
        expect(
          renderSkill(id, true),
          `${id} compliant render must include the replacement`,
        ).to.match(prose);
        expect(
          renderSkill(id, false),
          `${id} full render must not include the compliant-only block`,
        ).to.not.match(prose);
      }
    });

    // Regression guard: the omit and its compliant-only replacement share step
    // numbers (2, 3) so exactly one is ever present — the recipe must read as a
    // contiguous 1..N in BOTH modes, never a gap where a step was cut.
    it('renders contiguous recipe numbering in both modes', () => {
      for (const compliant of [true, false]) {
        const body = renderSkill('snapshot-misses', compliant);
        const steps = (body.match(/^\d+\. /gm) ?? []).map((s) =>
          parseInt(s, 10),
        );
        expect(steps, `snapshot-misses steps (compliant=${compliant})`).to.eql([
          1, 2, 3, 4,
        ]);
      }
    });
  });

  // The block strippers only match exact, balanced markers; a malformed one
  // would silently retain a prohibited block in the compliant render. The
  // load-time validator turns that latent per-render leak into a boot failure.
  describe('marker validation is fail-closed (guards against a silent leak)', () => {
    const okBody = 'a\n<!-- compliant-omit -->\nx\n<!-- /compliant-omit -->\nb';

    it('accepts well-formed omit and only blocks', () => {
      expect(() => validateMarkers(okBody, 'f')).to.not.throw();
      expect(() =>
        validateMarkers(
          '<!-- compliant-only -->\ny\n<!-- /compliant-only -->',
          'f',
        ),
      ).to.not.throw();
    });

    it('every shipped skill body passes (regression: files stay well-formed)', () => {
      for (const s of skillsRegistry) {
        expect(() => validateMarkers(s.body, s.path), s.id).to.not.throw();
      }
    });

    const bad: ReadonlyArray<[string, string, RegExp]> = [
      ['unclosed', '<!-- compliant-omit -->\nx', /unclosed/i],
      ['close without open', 'x\n<!-- /compliant-omit -->', /unbalanced/i],
      [
        'mismatched kind',
        '<!-- compliant-omit -->\nx\n<!-- /compliant-only -->',
        /unbalanced/i,
      ],
      [
        'nested',
        '<!-- compliant-omit --><!-- compliant-omit -->x<!-- /compliant-omit --><!-- /compliant-omit -->',
        /nested/i,
      ],
      [
        'typo',
        '<!-- compliant-omt -->\nx\n<!-- /compliant-omt -->',
        /malformed/i,
      ],
      [
        'extra spacing',
        '<!--  compliant-omit  -->\nx\n<!-- /compliant-omit -->',
        /malformed/i,
      ],
    ];
    for (const [name, body, re] of bad) {
      it(`throws on a ${name} marker`, () => {
        expect(() => validateMarkers(body, 'f')).to.throw(re);
      });
    }
  });

  // The agent reply path appends auto-injected skill bodies + a site-recipe
  // pointer. Both must respect the surface: compliant de-fangs the skills and
  // suppresses site recipes (which prescribe proxy/evaluate/login). Testing the
  // pure builder locks both call-sites' `compliant` threading without a live
  // session (a regression flipping either to the wrong branch fails here).
  describe('agent reply extras respect the surface', () => {
    const RECIPE_URL = 'https://airbnb.com'; // a host with a site recipe

    // Recipes now come from the remote skill bucket, so seed the host the way a
    // live GET /skills would before exercising the notice path.
    beforeEach(() => {
      __resetRemoteSkillsForTesting();
      return hydrateRemoteSkills(
        RECIPE_URL,
        'https://api.example.com',
        'test-token',
        { browserlessApiUrl: 'https://api.example.com' },
        (async () =>
          ({
            ok: true,
            json: async () => [
              {
                task: 'search-listings',
                title: 'Airbnb Search',
                skill_md:
                  '---\nname: search-listings\ntitle: Airbnb Search\nwebsite: airbnb.com\n---\n# Airbnb Search\n## Purpose\nx',
              },
            ],
          }) as unknown as Response) as typeof fetch,
      );
    });

    afterEach(() => __resetRemoteSkillsForTesting());

    it('compliant: de-fangs skills + suppresses site recipes', () => {
      const { skills, siteNotice } = buildSurfaceExtras(
        true,
        ['shadow-dom'],
        RECIPE_URL,
        new Set(),
      );
      expect(siteNotice, 'no site-recipe pointer on compliant').to.equal('');
      expect(skills, 'skill body de-fanged').to.not.match(
        /\bevaluate\b|recaptcha|hcaptcha|turnstile/i,
      );
      expect(skills.length, 'skill still rendered').to.be.greaterThan(200);
    });

    it('full: keeps site recipes + full skill guidance', () => {
      const { skills, siteNotice } = buildSurfaceExtras(
        false,
        ['shadow-dom'],
        RECIPE_URL,
        new Set(),
      );
      expect(siteNotice, 'site-recipe pointer surfaces on full').to.match(
        /SITE RECIPE/i,
      );
      expect(skills, 'full retains evaluate guidance').to.match(
        /\bevaluate\b/i,
      );
    });
  });
});
