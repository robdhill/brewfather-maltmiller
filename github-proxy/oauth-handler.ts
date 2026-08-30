// "Sign in with GitHub" login for the GitHub MCP proxy.
//
// Instead of a shared password, the browser is sent through a real GitHub
// OAuth login (using a GitHub OAuth App you already control), and we check
// that the account that logs in is actually you (ALLOWED_GITHUB_USERNAME)
// before completing the authorization Claude is waiting on. This matters:
// without that allowlist check, *any* GitHub user could sign in here and
// get an access token letting them use this proxy — and therefore your
// PAT — through Claude.
//
// Required secrets (wrangler secret put):
//   GITHUB_OAUTH_CLIENT_ID       - from your existing GitHub OAuth App
//   GITHUB_OAUTH_CLIENT_SECRET   - from the same OAuth App
//   ALLOWED_GITHUB_USERNAME      - your GitHub login, e.g. "robdhill"
//
// The OAuth App's "Authorization callback URL" (in its GitHub settings)
// must be set to: https://<your-worker>.workers.dev/gh-proxy/callback

export interface OauthHandlerEnv {
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERNAME: string;
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

function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><html><body style="font-family: sans-serif; max-width: 420px; margin: 80px auto;">
      <h2>Sign-in failed</h2>
      <p style="color: #c0392b;">${message}</p>
    </body></html>`,
    { status, headers: { "Content-Type": "text/html" } },
  );
}

function randomNonce(): string {
  return crypto.randomUUID();
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  const match = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

export const defaultHandler = {
  async fetch(
    request: Request,
    env: OauthHandlerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Step 1: Claude (via OAuthProvider) sends the browser here first.
    // We stash the pending auth request in `state` and bounce to GitHub.
    if (url.pathname === "/gh-proxy/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

      const csrf = randomNonce();
      const state = encodeURIComponent(
        btoa(JSON.stringify({ oauthReqInfo, csrf })),
      );

      const githubAuthorizeUrl = new URL("https://github.com/login/oauth/authorize");
      githubAuthorizeUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
      githubAuthorizeUrl.searchParams.set(
        "redirect_uri",
        new URL("/gh-proxy/callback", url.origin).toString(),
      );
      githubAuthorizeUrl.searchParams.set("scope", "read:user");
      githubAuthorizeUrl.searchParams.set("state", state);

      return new Response(null, {
        status: 302,
        headers: {
          Location: githubAuthorizeUrl.toString(),
          "Set-Cookie": `gh_csrf=${csrf}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/gh-proxy`,
        },
      });
    }

    // Step 2: GitHub redirects back here after the user logs in / approves.
    if (url.pathname === "/gh-proxy/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const githubError = url.searchParams.get("error");

      if (githubError) {
        return errorPage(`GitHub login was not completed (${githubError}).`);
      }
      if (!code || !state) {
        return errorPage("Missing code or state from GitHub's redirect.");
      }

      let parsedState: { oauthReqInfo: any; csrf: string };
      try {
        parsedState = JSON.parse(atob(decodeURIComponent(state)));
      } catch {
        return errorPage("Could not parse OAuth state — try signing in again.");
      }

      const cookieCsrf = getCookie(request, "gh_csrf");
      if (!cookieCsrf || cookieCsrf !== parsedState.csrf) {
        return errorPage(
          "CSRF check failed — the sign-in link may have expired. Try again.",
          403,
        );
      }

      // Exchange the code for a GitHub access token.
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_OAUTH_CLIENT_ID,
          client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: new URL("/gh-proxy/callback", url.origin).toString(),
        }),
      });

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenData.access_token) {
        return errorPage(
          `GitHub token exchange failed: ${tokenData.error_description ?? tokenData.error ?? "unknown error"}`,
        );
      }

      // Confirm *who* just logged in before granting anything.
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "User-Agent": "github-mcp-proxy",
          Accept: "application/vnd.github+json",
        },
      });

      if (!userResponse.ok) {
        return errorPage("Could not fetch GitHub identity after login.");
      }

      const githubUser = (await userResponse.json()) as { login: string };

      if (githubUser.login !== env.ALLOWED_GITHUB_USERNAME) {
        return errorPage(
          `This proxy is only authorized for the GitHub account "${env.ALLOWED_GITHUB_USERNAME}". You signed in as "${githubUser.login}".`,
          403,
        );
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: parsedState.oauthReqInfo,
        userId: githubUser.login,
        metadata: { label: `GitHub: ${githubUser.login}` },
        scope: parsedState.oauthReqInfo.scope,
        props: {},
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          // Clear the CSRF cookie now that it's served its purpose.
          "Set-Cookie": "gh_csrf=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/gh-proxy",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
