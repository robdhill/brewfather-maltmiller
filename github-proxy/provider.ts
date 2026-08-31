import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { buildMergedProxyServer, type GithubProxyEnv } from "./mcp-proxy";
import { defaultHandler } from "./oauth-handler";

const apiHandler = {
  async fetch(
    request: Request,
    env: GithubProxyEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const server = buildMergedProxyServer(env);
    return await createMcpHandler(() => server)(request, env, ctx);
  },
};

export const githubProxyProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/gh-proxy/authorize",
  tokenEndpoint: "/gh-proxy/token",
  clientRegistrationEndpoint: "/gh-proxy/register",
  scopesSupported: ["mcp"],
});
