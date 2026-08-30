import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { buildGithubProxyServer, type GithubProxyEnv } from "./mcp-proxy";
import { defaultHandler } from "./oauth-handler";

// The apiHandler is only ever invoked for requests OAuthProvider has already
// verified carry a valid access token it issued — the real GitHub PAT never
// travels over the wire to Claude at any point.
const apiHandler = {
  async fetch(
    request: Request,
    env: GithubProxyEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const server = buildGithubProxyServer(env);
    return await createMcpHandler(() => server)(request, env, ctx);
  },
};

// Wires up OAuth 2.1 + Dynamic Client Registration so claude.ai's connector
// UI (which only supports a server URL + OAuth, not a static header) can
// register itself and complete a login against defaultHandler's password
// gate. Once authorized, every /gh-proxy/mcp request is handled by
// apiHandler above, which proxies onward to GitHub's real remote MCP server.
//
// Requires a KV namespace bound as OAUTH_KV in wrangler.jsonc for grant/token
// storage — see the comment there for how to provision it.
export const githubProxyProvider = new OAuthProvider({
  apiRoute: "/gh-proxy/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/gh-proxy/authorize",
  tokenEndpoint: "/gh-proxy/token",
  clientRegistrationEndpoint: "/gh-proxy/register",
  scopesSupported: ["mcp"],
});
