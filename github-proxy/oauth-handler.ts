// Minimal single-user login/consent screen for the GitHub MCP proxy.
//
// This proxy exists purely so *you* can connect Claude to your own scoped
// GitHub PAT (since claude.ai's connector UI only supports OAuth, not a
// static header). There's no real multi-tenant client management here —
// just a shared password gate in front of OAuthProvider's
// completeAuthorization() call. Set the password via
// `wrangler secret put GH_PROXY_LOGIN_PASSWORD`.

export interface OauthHandlerEnv {
  GH_PROXY_LOGIN_PASSWORD: string;
  // Injected by @cloudflare/workers-oauth-provider at runtime — not declared
  // in wrangler.jsonc, so it's typed loosely here.
  OAUTH_PROVIDER: {
    parseAuthRequest: (request: Request) => Promise<any>;
    completeAuthorization: (opts: {
      request: any;
      userId: string;
      metadata: Record<string, unknown>;
      scope: string[];
      props: Record<string, unknown>;
    }) => Promise<{ redirectTo: string }>;
  };
}

function loginPage(error?: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>GitHub MCP Proxy</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="font-family: sans-serif; max-width: 420px; margin: 80px auto;">
    <h2>GitHub MCP Proxy</h2>
    <p>Enter the proxy password to authorize this Claude connection to use your scoped GitHub PAT.</p>
    ${error ? `<p style="color: #c0392b;">${error}</p>` : ""}
    <form method="POST">
      <input
        type="password"
        name="password"
        placeholder="Password"
        style="width: 100%; padding: 8px; box-sizing: border-box;"
        required
      />
      <button type="submit" style="margin-top: 12px; padding: 8px 16px;">
        Authorize
      </button>
    </form>
  </body>
</html>`;
}

export const defaultHandler = {
  async fetch(
    request: Request,
    env: OauthHandlerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/gh-proxy/authorize") {
      return new Response("Not found", { status: 404 });
    }

    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

    if (request.method === "GET") {
      return new Response(loginPage(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const password = form.get("password");

      if (password !== env.GH_PROXY_LOGIN_PASSWORD) {
        return new Response(loginPage("Incorrect password."), {
          status: 401,
          headers: { "Content-Type": "text/html" },
        });
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "robdhill",
        metadata: { label: "robdhill primary GitHub account (scoped PAT)" },
        scope: oauthReqInfo.scope,
        props: {},
      });

      return Response.redirect(redirectTo, 302);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
