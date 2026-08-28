import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";

export interface Env {
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
  MYBROWSER: Fetcher; // Cloudflare Puppeteer binding defined in wrangler.jsonc
}

interface Fermentable {
  name: string;
  amount: number; // kg
}

interface Hop {
  name: string;
  amount: number; // grams
}

interface Yeast {
  name: string;
}

interface BrewfatherRecipe {
  _id: string;
  name: string;
  fermentables: Fermentable[];
  hops: Hop[];
  yeasts: Yeast[];
}

// 1. Fetch recipe from Brewfather API
async function fetchBrewfatherRecipe(
  recipeId: string,
  userId: string,
  apiKey: string,
): Promise<BrewfatherRecipe> {
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
    throw new Error(
      `Brewfather API failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as BrewfatherRecipe;
}

// Small helper since page.waitForTimeout was removed in newer Puppeteer versions
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 2. Playwright/Puppeteer Automation with Strict Network Security
async function stageCartOnMaltMiller(
  recipe: BrewfatherRecipe,
  env: Env,
): Promise<string[]> {
  const browser = await puppeteer.launch(env.MYBROWSER);
  const results: string[] = [];

  try {
    const page = await browser.newPage();

    // STRICT DOMAIN LOCKDOWN
    // Drop any network requests NOT bound for The Malt Miller
    const ALLOWED_DOMAINS = ["themaltmiller.co.uk", "www.themaltmiller.co.uk"];

    await page.setRequestInterception(true);
    page.on("request", (interceptedRequest) => {
      const requestUrl = new URL(interceptedRequest.url());
      const isAllowed = ALLOWED_DOMAINS.some((domain) =>
        requestUrl.hostname.endsWith(domain),
      );

      if (isAllowed) {
        interceptedRequest.continue();
      } else {
        console.warn(
          `[SECURITY BLOCK] Blocked request to: ${requestUrl.hostname}`,
        );
        interceptedRequest.abort("accessdenied");
      }
    });

    // Set standard viewport & realistic User-Agent to prevent bot blocking
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // Combine fermentables, hops, and yeast into a flat search list
    const itemsToSearch = [
      ...(recipe.fermentables || []).map((f) => ({
        name: f.name,
        qty: `${f.amount}kg`,
      })),
      ...(recipe.hops || []).map((h) => ({
        name: h.name,
        qty: `${h.amount}g`,
      })),
      ...(recipe.yeasts || []).map((y) => ({ name: y.name, qty: "1 pkt" })),
    ];

    for (const item of itemsToSearch) {
      try {
        // Navigate directly to search page for each ingredient
        const searchUrl = `https://www.themaltmiller.co.uk/?s=${encodeURIComponent(item.name)}&post_type=product`;
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        // Check if WooCommerce product results exist
        const firstProductSelector =
          ".products .product a.woocommerce-LoopProduct-link, article.product h2 a";
        const hasProduct = await page.$(firstProductSelector);

        if (hasProduct) {
          // Click into the top matching product
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: 15000,
            }),
            page.click(firstProductSelector),
          ]);

          // Attempt to locate and click 'Add to basket'
          const addToCartBtn = "button.single_add_to_cart_button";
          if (await page.$(addToCartBtn)) {
            await page.click(addToCartBtn);
            await delay(1000); // Wait briefly for AJAX basket update
            results.push(`✅ Added match for "${item.name}" (${item.qty})`);
          } else {
            results.push(
              `⚠️ Found page for "${item.name}", but could not locate Add-To-Cart button.`,
            );
          }
        } else {
          results.push(`❌ No matching product found for "${item.name}".`);
        }
      } catch (err: any) {
        results.push(`⚠️ Error processing "${item.name}": ${err.message}`);
      }
    }

    return results;
  } finally {
    // Always close browser session to prevent daily 10-minute free allowance depletion
    await browser.close();
  }
}

// 3. Build the MCP server per-request, closing over the real `env`
function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "brewfather-maltmiller-automator",
    version: "1.0.0",
  });

  // Register Tool 1: Fetch & Preview Recipe
  server.tool(
    "get_brewfather_recipe",
    "Fetches fermentables, hops, and yeast from a Brewfather recipe ID.",
    { recipeId: z.string().describe("The Brewfather Recipe ID") },
    async ({ recipeId }) => {
      try {
        const recipe = await fetchBrewfatherRecipe(
          recipeId,
          env.BREWFATHER_USER_ID,
          env.BREWFATHER_API_KEY,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(recipe, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // Register Tool 2: Order / Stage Ingredients to Cart
  server.tool(
    "stage_malt_miller_cart",
    "Fetches a Brewfather recipe and automatically adds matching ingredients to The Malt Miller cart.",
    { recipeId: z.string().describe("The Brewfather Recipe ID") },
    async ({ recipeId }) => {
      try {
        if (!env.BREWFATHER_USER_ID || !env.BREWFATHER_API_KEY) {
          throw new Error(
            "Missing Brewfather credentials in Cloudflare secrets.",
          );
        }

        const recipe = await fetchBrewfatherRecipe(
          recipeId,
          env.BREWFATHER_USER_ID,
          env.BREWFATHER_API_KEY,
        );
        const executionLog = await stageCartOnMaltMiller(recipe, env);

        const summary = `
Staging complete for recipe "${recipe.name}"!

--- Execution Log ---
${executionLog.join("\n")}

🛒 Open your cart to review item quantities and checkout:
https://www.themaltmiller.co.uk/basket/
        `.trim();

        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Automation failed: ${err.message}` },
          ],
        };
      }
    },
  );

  return server;
}

// 4. Export Cloudflare Worker HTTP Handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Brewfather & Malt Miller MCP Server Running", {
        status: 200,
      });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      const server = buildServer(env);
      return await server.handleHttpMessage(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
