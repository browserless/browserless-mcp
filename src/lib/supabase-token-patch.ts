/**
 * Patch `globalThis.fetch` to extend `expires_in` on Supabase OAuth token
 * responses so MCP clients don't thrash refresh against Supabase's ~60s
 * default. Has to be global because FastMCP's OAuthProxy calls the token
 * endpoint itself and exposes no fetch hook. Match is origin- and
 * pathname-exact to avoid intercepting unrelated requests.
 */
export function installSupabaseTokenTtlPatch(
  supabaseUrl: string,
  ttlSeconds: number,
): void {
  const supabaseOrigin = new URL(supabaseUrl).origin;
  const TOKEN_PATHNAME = '/auth/v1/oauth/token';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof URL
          ? args[0].toString()
          : (args[0] as Request).url;
    const reqUrl = new URL(url);
    if (
      !response.ok ||
      reqUrl.origin !== supabaseOrigin ||
      reqUrl.pathname !== TOKEN_PATHNAME
    ) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.expires_in === 'number' && body.expires_in < ttlSeconds) {
      body.expires_in = ttlSeconds;
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
