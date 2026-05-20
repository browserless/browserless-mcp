/**
 * Narrowly patch `globalThis.fetch` to extend the `expires_in` on Supabase
 * OAuth token responses.
 *
 * Why a monkey-patch at all:
 *   FastMCP's OAuthProxy calls the upstream token endpoint itself
 *   (`exchangeAuthorizationCode` / `exchangeRefreshToken`). It does not expose
 *   a custom-fetch hook on its config, so a scoped helper inside this codebase
 *   wouldn't intercept those FastMCP-internal calls — only the global fetch
 *   override does.
 *
 * Why we extend the TTL:
 *   Supabase issues OAuth tokens with a very short TTL (~60s). With
 *   `enableTokenSwap: false`, FastMCP passes those tokens straight through to
 *   the MCP client, which then enters a refresh-loop. We rewrite the response
 *   body to advertise a longer `expires_in` so clients refresh on a saner
 *   schedule. Safe because we only ever decode the JWT payload for the
 *   accountId — we never use it as a bearer token against Supabase.
 *
 * Why the URL filter is tight:
 *   The override runs for every `fetch()` in the process, so the predicate
 *   must short-circuit on anything that isn't the Supabase token endpoint.
 *   Both the URL prefix AND the path are checked.
 */
export function installSupabaseTokenTtlPatch(
  supabaseUrl: string,
  ttlSeconds: number,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof URL
          ? args[0].toString()
          : (args[0] as Request).url;
    if (
      !response.ok ||
      !url.startsWith(supabaseUrl) ||
      !url.includes('/oauth/token')
    ) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.expires_in === 'number' &&
      body.expires_in < ttlSeconds
    ) {
      body.expires_in = ttlSeconds;
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
