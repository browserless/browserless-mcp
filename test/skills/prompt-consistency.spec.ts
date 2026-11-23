import { expect } from 'chai';
import { renderSkill, skillsRegistry } from '../../src/skills/index.js';
import {
  AGENT_SYSTEM_PROMPT,
  fileTransferModeNote,
  SELF_CHECK_DIRECTIVE,
  SERVER_INSTRUCTIONS,
  sessionContinuityNote,
  SKILL_TOOL_DESCRIPTION,
} from '../../src/skills/system-prompt.js';
import { closeReminder } from '../../src/tools/agent.js';
import { TypedAgentCommandSchema } from '../../src/tools/schemas.js';

const FULL =
  AGENT_SYSTEM_PROMPT +
  fileTransferModeNote('httpStream', 'https://mcp.browserless.io') +
  SELF_CHECK_DIRECTIVE +
  sessionContinuityNote('httpStream');
const SURFACES = [
  FULL,
  SKILL_TOOL_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  closeReminder(false),
  ...skillsRegistry.map(({ id }) => renderSkill(id, false)),
].join('\n');

const section = (heading: string) =>
  AGENT_SYSTEM_PROMPT.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

describe('full agent prompt consistency', () => {
  it('does not grow beyond its baseline sizes', () => {
    expect(AGENT_SYSTEM_PROMPT.length).to.be.at.most(22996);
    expect(FULL.length).to.be.at.most(25737);
  });

  it('contains no untrue or circular statements', () => {
    for (const phrase of [
      'own call',
      'NOT batched',
      'See schema for',
      'schema authoritative',
      'schema is authoritative',
      'from the schema',
      'Do NOT batch across navigations',
      'standard agent loop',
      'prefiltered URL + evaluate',
      '`goto` + `text`/`html`/`evaluate`',
    ]) {
      expect(SURFACES.toLowerCase()).not.to.include(phrase.toLowerCase());
    }
    expect(AGENT_SYSTEM_PROMPT).not.to.include('(see above)');
  });

  it('states each rule once', () => {
    for (const rule of [
      'Never write site-specific classes, ids or attributes from memory',
      "returns only its last command's result",
      'Until you snapshot a page you cannot click',
      'at most one page-changing command',
      'one-shot by default',
      'as the last command of your final batch',
      'A click that reveals new controls',
      'Loaded a site recipe? Set',
      "**Report the outcome after you've seen the results.**",
    ]) {
      expect(FULL.split(rule)).to.have.length(2, rule);
    }
  });

  it('keeps one section for each topic in reading order', () => {
    expect(AGENT_SYSTEM_PROMPT.match(/^## .+$/gm)).to.deep.equal([
      '## Loop',
      '## Rules',
      '## Session lifetime and close',
      '## Reporting',
      '## Human handoff',
      '## Site recipes',
      '## Proxy (optional)',
      '## OS persona (optional)',
      '## Auth',
      '## Terminal-Goal Check',
      '## Skills',
      '## Snapshots',
      '## Reading content',
      '## Files',
      '## Async',
      '## Error Recovery',
      '## Commands',
    ]);
  });

  it('lists every typed command', () => {
    for (const option of TypedAgentCommandSchema.options) {
      const command = option.shape.method.value;
      expect(section('Commands')).to.match(new RegExp(`\\b${command}\\b`));
    }
  });

  it('advertises the same skills in the prompt and the skill description', () => {
    const advertised = skillsRegistry
      .map(({ id }) => id)
      .filter((id) => id !== 'agentic-checkout')
      .sort();
    expect(
      [...section('Skills').matchAll(/^- `([^`]+)`/gm)]
        .map((match) => match[1])
        .sort(),
    ).to.deep.equal(advertised);
    expect(
      [...SKILL_TOOL_DESCRIPTION.matchAll(/^- \*\*([\w-]+)\*\*/gm)]
        .map((match) => match[1])
        .sort(),
    ).to.deep.equal(advertised);
  });

  it('works as stand-alone instructions', () => {
    expect(AGENT_SYSTEM_PROMPT).not.to.match(/tool description|the schema/i);
  });

  it('uses a grounded one-shot read example', () => {
    const example = section('Session lifetime and close')
      .split('\n')
      .find((line) => line.includes('One batch finishes the whole task'));
    expect(example).to.include('`text`');
    expect(example).not.to.include('`evaluate`');
  });
});
