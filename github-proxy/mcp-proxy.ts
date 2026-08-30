import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

// Tools that are never exposed through the proxy, regardless of what the
// upstream PAT's own permissions would otherwise allow. This is an *extra*
// layer on top of PAT scoping, not a replacement for it — the PAT itself
// should still be a fine-grained token limited to only the repos and
// permissions you actually need. Adjust this list to taste; tool names must
// match exactly what GitHub's remote MCP server calls them.
const BLOCKED_TOOLS = new Set<string>([
  "merge_pull_request",
  "delete_file",
  "fork_repository",
  "create_repository",
]);

export interface GithubProxyEnv {
  GITHUB_PROXY_PAT: string;
}

async function connectUpstream(env: GithubProxyEnv): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(GITHUB_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PROXY_PAT}`,
      },
    },
  });

  const client = new Client(
    { name: "github-mcp-proxy", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

// Builds a fresh proxy server per request. It lazily connects to GitHub's
// real remote MCP server using the PAT held server-side (env.GITHUB_PROXY_PAT,
// set via `wrangler secret put`), mirrors its tool list minus anything in
// BLOCKED_TOOLS, and forwards every allowed call straight through.
//
// NOTE: this uses the low-level `Server` class (raw JSON-schema tool specs)
// rather than the `McpServer` convenience wrapper, because we're relaying
// tool definitions we received as JSON schema from upstream — McpServer's
// `.tool()` helper expects Zod shapes instead, which doesn't fit a generic
// passthrough. Double check `createMcpHandler` in the version of `agents`
// installed here accepts a raw `Server` — if its types insist on `McpServer`
// specifically, this will need a small compatibility shim.
export function buildGithubProxyServer(env: GithubProxyEnv): Server {
  const server = new Server(
    { name: "github-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  let upstreamPromise: Promise<Client> | null = null;
  const upstream = () => (upstreamPromise ??= connectUpstream(env));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await upstream();
    const { tools } = await client.listTools();
    return { tools: tools.filter((tool) => !BLOCKED_TOOLS.has(tool.name)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (BLOCKED_TOOLS.has(name)) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${name}" is blocked by this proxy's policy and cannot be called, regardless of the underlying PAT's permissions.`,
          },
        ],
        isError: true,
      };
    }

    const client = await upstream();
    return await client.callTool({ name, arguments: args });
  });

  return server;
}
