import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define Cloudflare Worker environment bindings
export interface Env {
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
  MYBROWSER: Fetcher; // Cloudflare Puppeteer binding
}

// Interfaces for Brewfather recipe items
interface Fermentable {
  name: string;
  amount: number; // in kg
  type?: string;
  use?: string;
}

interface Hop {
  name: string;
  amount: number; // in grams
  use?: string;
  time?: number;
  alpha?: number;
}

interface Yeast {
  name: string;
  amount: number;
  laboratory?: string;
  productId?: string;
}

interface BrewfatherRecipe {
  _id: string;
  name: string;
  fermentables: Fermentable[];
  hops: Hop[];
  yeasts: Yeast[];
}

// 1. Fetch recipe directly from Brewfather REST API v2
async function fetchBrewfatherRecipe(
  recipeId: string,
  userId: string,
  apiKey: string,
): Promise<BrewfatherRecipe> {
  // Brewfather API v2 requires Basic Auth using base64(userId:apiKey)
  const credentials = btoa(`${userId}:${apiKey}`);

  const response = await fetch(
    `https://api.brewfather.app/v2/recipes/${recipeId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Brewfather API authentication failed. Check your User ID and API Key.",
      );
    }
    throw new Error(
      `Brewfather API request failed with status: ${response.status}`,
    );
  }

  return (await response.json()) as BrewfatherRecipe;
}

// 2. Format extracted ingredients into a clean, normalized string
function formatRecipeSummary(recipe: BrewfatherRecipe): string {
  const malts =
    recipe.fermentables?.map((f) => `- ${f.name}: ${f.amount} kg`).join("\n") ||
    "None";

  const hops =
    recipe.hops
      ?.map((h) => `- ${h.name}: ${h.amount} g (${h.use || "Boil"})`)
      .join("\n") || "None";

  const yeasts =
    recipe.yeasts
      ?.map((y) =>
        `- ${y.laboratory || ""} ${y.name} (${y.productId || ""})`.trim(),
      )
      .join("\n") || "None";

  return `
                                                                                                                                  Recipe Name: ${recipe.name}
                                                                                                                                  Recipe ID: ${recipe._id}

                                                                                                                                  --- Fermentables ---
                                                                                                                                  ${malts}

                                                                                                                                  --- Hops ---
                                                                                                                                  ${hops}

                                                                                                                                  --- Yeast ---
                                                                                                                                  ${yeasts}
                                                                                                                                    `.trim();
}

// 3. Initialize the MCP Server
const server = new McpServer({
  name: "brewfather-maltmiller-automator",
  version: "1.0.0",
});

// Register the tool exposed to Gemini
server.tool(
  "get_brewfather_recipe",
  "Fetches and extracts fermentables, hops, and yeast from a Brewfather recipe ID.",
  {
    recipeId: z.string().describe("The 28-character Brewfather Recipe ID"),
  },
  async ({ recipeId }, env: Env) => {
    try {
      if (!env.BREWFATHER_USER_ID || !env.BREWFATHER_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BREWFATHER_USER_ID or BREWFATHER_API_KEY environment variables are not set in Cloudflare Secrets.",
            },
          ],
        };
      }

      const recipe = await fetchBrewfatherRecipe(
        recipeId,
        env.BREWFATHER_USER_ID,
        env.BREWFATHER_API_KEY,
      );

      const formattedData = formatRecipeSummary(recipe);

      return {
        content: [
          {
            type: "text",
            text: formattedData,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to fetch recipe: ${error.message}`,
          },
        ],
      };
    }
  },
);

// 4. Export Cloudflare Worker HTTP handler (Streamable HTTP / MCP Entrypoint)
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url());

    // Basic health check route
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Brewfather MCP Server active", { status: 200 });
    }

    // MCP Transport over HTTP
    if (url.pathname === "/mcp" && request.method === "POST") {
      // Connect request payload to the MCP Server instance
      const response = await server.handleHttpMessage(request, env);
      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
};
