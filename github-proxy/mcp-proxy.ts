import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LOCAL_TOOLS,
  isLocalTool,
  callLocalTool,
  type BrewfatherEnv,
} from "../brewfather-tools";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

const BLOCKED_TOOLS = new Set<string>([
  "merge_pull_request",
  "delete_file",
  "fork_repository",
  "create_repository",
]);

export interface GithubProxyEnv extends BrewfatherEnv {
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

export function buildMergedProxyServer(env: GithubProxyEnv): Server {
  const server = new Server(
    { name: "github-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  let upstreamPromise: Promise<Client> | null = null;
  const upstream = () => (upstreamPromise ??= connectUpstream(env));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await upstream();
    const { tools } = await client.listTools();
    const upstreamTools = tools.filter((tool) => !BLOCKED_TOOLS.has(tool.name));
    return { tools: [...LOCAL_TOOLS, ...upstreamTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (isLocalTool(name)) {
      return await callLocalTool(name, args, env);
    }

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
