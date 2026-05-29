import { z } from 'zod';

// NUL is the session-key separator (KEY_SEP) in agent-client.ts. Computed via
// fromCharCode so the literal control character never appears in source.
const NUL = String.fromCharCode(0);

/**
 * Build the schema for an optional profile field. The NUL refinement protects
 * the session-key separator used in agent-client.ts — a profile name
 * containing NUL could otherwise collide with another key.
 *
 * Dependency-clean (zod only) so it can be shared by the server tools and the
 * published `@browserless.io/mcp/schemas` surface without pulling in fastmcp.
 */
export function profileField(whenLoaded: string, extra = '') {
  const description =
    `Optional name of an authentication profile to hydrate into the browser ${whenLoaded}. ` +
    "The profile's cookies, localStorage, and IndexedDB are restored into the session before the request runs. " +
    'The profile must already exist for the API token in use — create one with Browserless.saveProfile in a live agent session first.' +
    extra;
  return z
    .string()
    .trim()
    .min(1)
    .refine((v) => !v.includes(NUL), {
      message: 'profile must not contain NUL characters',
    })
    .optional()
    .describe(description);
}
