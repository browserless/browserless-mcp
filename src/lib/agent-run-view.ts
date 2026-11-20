import { z } from 'zod';

export const AGENT_RUN_VIEW_MAX_BYTES = 1024 * 1024;
export const AGENT_RUN_MAX_TURNS = 20;
export const AGENT_RUN_MAX_ACTIONS = 500;
export const AGENT_RUN_MAX_NOTES = 200;
export const AGENT_RUN_NOTE_MAX_CHARS = 2000;
export const AGENT_RUN_QUERY_MAX_CHARS = 8000;
export const AGENT_RUN_RESULT_MAX_CHARS = 256 * 1024;
export const AGENT_RUN_RESULT_PREVIEW_CHARS = 4000;
export const AGENT_RUN_ERROR_MAX_CHARS = 2000;
export const AGENT_RUN_ID = /^run_[A-Za-z0-9]{1,64}$/;
export const AGENT_RUN_STATUSES = [
  'pending',
  'running',
  'needs_human',
  'succeeded',
  'failed',
  'timed_out',
  'stopped',
  'capped',
] as const;
export const AGENT_RUN_ACTIVE = ['pending', 'running', 'needs_human'] as const;
export const isActiveRun = (status: string) =>
  AGENT_RUN_ACTIVE.some((active) => active === status);

export const AGENT_RUN_STATUS_LABELS = {
  pending: 'Pending',
  running: 'Running',
  needs_human: 'Needs human',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  stopped: 'Stopped',
  capped: 'Capped',
};
export const AGENT_RUN_ACTION_LABELS = {
  ok: 'Succeeded',
  error: 'Failed',
  incomplete: 'Incomplete',
};
const REASON_LABELS = new Map([
  ['login_wall', 'sign-in needed'],
  ['step_up_mfa', 'verification needed'],
]);
const OUTCOME_LABELS = new Map([
  ['resumed', 'resumed'],
  ['userFailed', "the person couldn't finish"],
  ['expired', 'expired'],
  ['stopped', 'stopped'],
  ['closed', 'closed'],
]);
export const agentRunReasonLabel = (reason: string) =>
  REASON_LABELS.get(reason) ?? reason;
export const agentRunOutcomeLabel = (outcome: string) =>
  OUTCOME_LABELS.get(outcome) ?? outcome;

const count = z.number().int().nonnegative();
const date = z.string().datetime({ offset: true });
const status = z.enum(AGENT_RUN_STATUSES);
const runId = z.string().regex(AGENT_RUN_ID);
const command = z.object({
  method: z.string(),
  selector: z.string().optional(),
  url: z.string().optional(),
  textLength: count.optional(),
});
const action = z.object({
  seq: count,
  startedAt: date,
  durationMs: z.number().nonnegative().nullable().default(null),
  tool: z.string(),
  commands: z.array(command).default([]),
  status: z.enum(['ok', 'error', 'incomplete']),
  errorCode: z.string().optional(),
});
const handoff = z
  .object({ reason: z.string(), outcome: z.string().nullable().default(null) })
  .nullable();
const sourceTurn = z.object({
  turnId: z.string(),
  query: z.string().nullable().default(null),
  status: z.string(),
  units: z.number().default(0),
  actions: z.array(action).default([]),
  steps: z.array(z.string()).default([]),
  data: z.unknown().default(null),
});
export const AgentRunSourceSchema = z.object({
  id: runId,
  status,
  humanRequest: handoff.default(null),
  error: z.string().nullable().default(null),
  screenshot: z.string().nullable().default(null),
  formatErrors: z
    .object({ screenshot: z.string().nullable().default(null) })
    .optional(),
  turns: z.array(sourceTurn).default([]),
  created_at: date,
  completed_at: date.nullable().default(null),
  expires_at: date.nullable().default(null),
});
export const AgentRunListSchema = z.object({
  runs: z
    .array(
      AgentRunSourceSchema.pick({
        id: true,
        status: true,
        created_at: true,
        completed_at: true,
        expires_at: true,
      }).extend({
        queryPreview: z.string().nullable().default(null),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable().default(null),
});
const identity = z.object({
  runId,
  status,
  createdAt: date,
  completedAt: date.nullable(),
  runExpiresAt: date.nullable(),
  fetchedAt: date,
});
export const AgentRunSummarySchema = identity.extend({
  active: z.boolean(),
  turnCount: count,
  actionCount: count,
  failedActionCount: count,
  incompleteActionCount: count,
});
const boundedTurn = sourceTurn
  .pick({ turnId: true, status: true, units: true })
  .extend({
    query: z.string().max(AGENT_RUN_QUERY_MAX_CHARS).nullable(),
    actions: z.array(action).max(AGENT_RUN_MAX_ACTIONS),
    actionsTruncated: z.boolean(),
    notes: z
      .array(z.string().max(AGENT_RUN_NOTE_MAX_CHARS))
      .max(AGENT_RUN_MAX_NOTES),
    notesTruncated: z.boolean(),
    answer: z.string().max(AGENT_RUN_RESULT_MAX_CHARS).nullable(),
    result: z.string().max(AGENT_RUN_RESULT_MAX_CHARS).nullable(),
    resultTruncated: z.boolean(),
  });
export const AgentRunPayloadSchema = identity.extend({
  error: z.string().max(AGENT_RUN_ERROR_MAX_CHARS).nullable(),
  humanRequest: handoff,
  turns: z.array(boundedTurn).max(AGENT_RUN_MAX_TURNS),
  turnsTruncated: z.boolean(),
  screenshot: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), viewRef: z.string().max(128) }),
    z.object({ state: z.literal('unavailable'), reason: z.string() }),
    z.object({ state: z.literal('none') }),
  ]),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
export type AgentRunPayload = z.infer<typeof AgentRunPayloadSchema>;

export function buildAgentRun(source: unknown, fetchedAt: string) {
  const parsed = AgentRunSourceSchema.safeParse(source);
  if (!parsed.success) throw new Error('Unexpected agent run response.');
  const run = parsed.data;
  const turns = run.turns.slice(0, AGENT_RUN_MAX_TURNS).map((turn) => {
    const data = turn.data;
    const answer =
      data && typeof data === 'object' && 'answer' in data ? data.answer : null;
    const result = data === null ? null : JSON.stringify(data, null, 2);
    return {
      turnId: turn.turnId,
      status: turn.status,
      units: turn.units,
      query: turn.query?.slice(0, AGENT_RUN_QUERY_MAX_CHARS) ?? null,
      actions: turn.actions
        .sort((a, b) => a.seq - b.seq)
        .slice(0, AGENT_RUN_MAX_ACTIONS),
      actionsTruncated: turn.actions.length > AGENT_RUN_MAX_ACTIONS,
      notes: turn.steps
        .slice(0, AGENT_RUN_MAX_NOTES)
        .map((note) => note.slice(0, AGENT_RUN_NOTE_MAX_CHARS)),
      notesTruncated: turn.steps.length > AGENT_RUN_MAX_NOTES,
      answer:
        typeof answer === 'string'
          ? answer.slice(0, AGENT_RUN_RESULT_MAX_CHARS)
          : null,
      result: result?.slice(0, AGENT_RUN_RESULT_MAX_CHARS) ?? null,
      resultTruncated: (result?.length ?? 0) > AGENT_RUN_RESULT_MAX_CHARS,
    };
  });
  const actions = turns.flatMap((turn) => turn.actions);
  const snapshot = {
    runId: run.id,
    status: run.status,
    fetchedAt,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    runExpiresAt: run.expires_at,
  };
  const summary: AgentRunSummary = {
    ...snapshot,
    active: isActiveRun(run.status),
    turnCount: turns.length,
    actionCount: actions.length,
    failedActionCount: actions.filter(({ status }) => status === 'error')
      .length,
    incompleteActionCount: actions.filter(
      ({ status }) => status === 'incomplete',
    ).length,
  };
  const payload: Omit<AgentRunPayload, 'screenshot'> = {
    ...snapshot,
    turns,
    turnsTruncated: run.turns.length > AGENT_RUN_MAX_TURNS,
    error: run.error?.slice(0, AGENT_RUN_ERROR_MAX_CHARS) ?? null,
    humanRequest: run.humanRequest,
  };
  return {
    summary,
    payload,
    screenshotBase64: run.screenshot,
    screenshotError: run.formatErrors?.screenshot ?? null,
  };
}

export function agentRunSummaryLine(summary: AgentRunSummary): string {
  const {
    runId,
    status,
    turnCount,
    actionCount,
    failedActionCount,
    incompleteActionCount,
  } = summary;
  return `Agent run ${runId}: ${AGENT_RUN_STATUS_LABELS[status]} · ${turnCount} turn${turnCount === 1 ? '' : 's'} · ${actionCount} action${actionCount === 1 ? '' : 's'} (${failedActionCount} failed, ${incompleteActionCount} incomplete).`;
}

export function formatAgentRunCommand({
  method,
  selector,
  url,
  textLength,
}: z.infer<typeof command>): string {
  return [
    method,
    selector,
    url,
    textLength === undefined ? undefined : `(${textLength} chars typed)`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatAgentRunText(
  payload: Omit<AgentRunPayload, 'screenshot'>,
  summary: AgentRunSummary,
  { timeline }: { timeline: boolean },
): string {
  const lines = [agentRunSummaryLine(summary), `Started ${payload.createdAt}`];
  if (payload.completedAt) lines.push(`Completed ${payload.completedAt}`);
  if (payload.error) lines.push(`Error: ${payload.error}`);
  if (payload.humanRequest) {
    const { reason, outcome } = payload.humanRequest;
    const label = agentRunReasonLabel(reason);
    if (payload.status === 'needs_human')
      lines.push(`Waiting for a person to take over — ${label}.`);
    else
      lines.push(
        `Handoff: ${label}${outcome ? ` — ${agentRunOutcomeLabel(outcome)}` : ''}.`,
      );
  }
  const last = payload.turns.at(-1);
  const answer = last?.answer ?? last?.result ?? null;
  if (answer === null) lines.push('Result: unavailable.');
  else
    lines.push(
      answer.length > AGENT_RUN_RESULT_PREVIEW_CHARS
        ? 'Result (first 4,000 characters, truncated):'
        : 'Result:',
      answer.slice(0, AGENT_RUN_RESULT_PREVIEW_CHARS),
    );
  if (timeline)
    payload.turns.forEach((turn, index) => {
      lines.push(
        '',
        `## Turn ${index + 1}: ${turn.query ?? 'Task unavailable'}`,
      );
      for (const entry of turn.actions) {
        lines.push(
          [
            `${entry.seq}. ${entry.tool}`,
            entry.commands.map(formatAgentRunCommand).join('; '),
            AGENT_RUN_ACTION_LABELS[entry.status],
            entry.durationMs === null
              ? 'duration unavailable'
              : `${entry.durationMs} ms`,
            entry.errorCode,
          ]
            .filter(Boolean)
            .join(' — '),
        );
      }
      if (turn.actionsTruncated) lines.push('Showing the first 500 actions.');
      if (turn.notes.length)
        lines.push('### Agent notes', ...turn.notes.map((note) => `- ${note}`));
      if (!turn.actions.length && !turn.notes.length)
        lines.push('No steps recorded.');
    });
  return lines.join('\n');
}

export function formatAgentRunList({
  runs,
  nextCursor,
}: z.infer<typeof AgentRunListSchema>): string {
  if (!runs.length) return 'No agent runs found.';
  const lines = [
    `## Agent runs (${runs.length})`,
    ...runs.map(
      (run) =>
        `- ${run.id} · ${AGENT_RUN_STATUS_LABELS[run.status]} · ${run.created_at} · ${run.queryPreview ?? 'Task unavailable'}`,
    ),
  ];
  if (nextCursor)
    lines.push(
      `More runs are available — pass cursor: ${JSON.stringify(nextCursor)}.`,
    );
  return lines.join('\n');
}
