import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The real, official remote GitHub MCP server we're proxying.
const GITHUB_REMOTE_MCP_URL = "https://api.githubcopilot.com/mcp/";

export interface GithubProxyEnv {
  // Fine-grained GitHub PAT, scoped to only the repos/permissions this proxy
  // should be able to touch. Set with: wrangler secret put GITHUB_PROXY_PAT
  GITHUB_PROXY_PAT: string;

  // Optional comma-separated override for the blocked-tools list below,
  // e.g. "merge_pull_request,delete_file,create_repository". If unset, the
  // DEFAULT_BLOCKED_TOOLS list is used.
  GITHUB_PROXY_BLOCKED_TOOLS?: string;
}

// Tools that stay blocked on this proxy no matter what the PAT itself would
// allow. A fine-grained PAT scopes by resource + permission (e.g. "contents:
// write"), not by individual tool, so this is how we express "never allow
// destructive/irreversible actions" on top of that.
//
// This list is a starting point, not a guarantee — review it against your
// own risk tolerance and the current GH Remote tool list before relying on
// it. Tool names come from GitHub's official remote MCP server and may
// change as it evolves.
const DEFAULT_BLOCKED_TOOLS = new Set([
  "delete_file",
  "merge_pull_request",
  "create_repository",
  "fork_repository",
]);

function getBlockedTools(env: GithubProxyEnv): Set<string> {
  if (env.GITHUB_PROXY_BLOCKED_TOOLS) {
    return new Set(
      env.GITHUB_PROXY_BLOCKED_TOOLS.split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
  }
  return DEFAULT_BLOCKED_TOOLS;
}

// Connects a fresh MCP client to the real GitHub remote server, authenticated
// with the scoped PAT. A new connection per call is simpler and safer than
// trying to cache a long-lived upstream client across Worker invocations
// (Workers can be recycled at any time), at the cost of one extra round trip
// per tool call — worth revisiting if latency becomes a problem.
async function connectUpstreamClient(pat: string): Promise<Client> {
  const client = new Client({
    name: "github-remote-proxy-upstream-client",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(GITHUB_REMOTE_MCP_URL),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${pat}`,
        },
      },
    },
  );

  await client.connect(transport);
  return client;
}

// Builds the MCP server exposed to Claude. Rather than statically declaring
// each GitHub tool (there are dozens, and they change over time), this uses
// the low-level Server API to forward list_tools/call_tool requests straight
// through to the real GitHub remote server, filtering the blocked-tools list
// out of both the listing and any call attempts.
export function buildGithubProxyServer(env: GithubProxyEnv): Server {
  const server = new Server(
    { name: "github-remote-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const blocked = getBlockedTools(env);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstream = await connectUpstreamClient(env.GITHUB_PROXY_PAT);
    try {
      const result = await upstream.listTools();
      return {
        tools: result.tools.filter((tool) => !blocked.has(tool.name)),
      };
    } finally {
      await upstream.close();
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (blocked.has(name)) {
      return {
        content: [
          {
            type: "text",
            text: `Blocked: "${name}" is disabled on this proxy regardless of the PAT's own permissions.`,
          },
        ],
        isError: true,
      };
    }

    const upstream = await connectUpstreamClient(env.GITHUB_PROXY_PAT);
    try {
      return await upstream.callTool({ name, arguments: args });
    } finally {
      await upstream.close();
    }
  });

  return server;
}
