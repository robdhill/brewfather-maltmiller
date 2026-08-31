import { githubProxyProvider } from "./github-proxy/provider";

export interface Env {
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
  MYBROWSER: Fetcher;
  GITHUB_PROXY_PAT: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERNAME: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    const OAUTH_ROOT_ALIASES: Record<string, string> = {
      "/authorize": "/gh-proxy/authorize",
      "/token": "/gh-proxy/token",
      "/register": "/gh-proxy/register",
    };
    if (url.pathname in OAUTH_ROOT_ALIASES) {
      url.pathname = OAUTH_ROOT_ALIASES[url.pathname];
      request = new Request(url.toString(), request);
    }

    if (
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/gh-proxy") ||
      url.pathname.startsWith("/.well-known/oauth-")
    ) {
      return await githubProxyProvider.fetch(request, env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Brewfather & Malt Miller MCP Server Running", {
        status: 200,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
