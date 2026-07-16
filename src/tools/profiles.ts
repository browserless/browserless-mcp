import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  ListProfilesRequest,
  McpConfig,
  ProfileSummary,
} from '../@types/types.js';

export const ListProfilesParamsSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe('Maximum number of profiles to return (default: 100, max: 1000)'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of profiles to skip for pagination (default: 0)'),
});

export function registerProfilesTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<ListProfilesRequest, ProfileSummary[]>(server, config, analytics, {
    name: 'browserless_profiles',
    description:
      'List the authentication profiles saved for the current token. ' +
      'A profile is a saved logged-in browser state (cookies + storage) that ' +
      'can be replayed by passing its name as `profile` to other tools. ' +
      'Call this before a task that needs the browser to start signed in, to ' +
      'discover which profiles already exist and pick one by name. ' +
      'Returns each profile name plus cookie/origin counts and last-used time.',
    parameters: ListProfilesParamsSchema,
    annotations: {
      title: 'Browserless Profiles',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async ({ client, params, log }) => {
      const profiles = await client.listProfiles(params);
      log.debug(`Listed ${profiles.length} profile(s)`);
      return profiles;
    },
    analyticsProps: (_params, result) => ({ profiles_found: result.length }),
    format: (profiles) => {
      if (profiles.length === 0) {
        return [
          {
            type: 'text' as const,
            text: 'No saved profiles for this token. Create one by running an authenticated session with `createProfile` (see the auth-profile skill).',
          },
        ];
      }
      const list = profiles
        .map(
          (p) =>
            `- ${p.name} — ${p.cookieCount} cookies, ${p.originCount} origins (last used: ${p.lastUsedAt ?? 'never used'})`,
        )
        .join('\n');
      return [
        {
          type: 'text' as const,
          text: `## Saved Profiles (${profiles.length})\n\n${list}\n\nPass a profile's name as \`profile\` to reuse its logged-in state.`,
        },
      ];
    },
  });
}
