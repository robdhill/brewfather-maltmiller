import puppeteer from "@cloudflare/puppeteer";

export interface BrewfatherEnv {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SearchItem {
  name: string;
  qty: string;
  desiredQuantity: number;
}

async function stageCartOnMaltMiller(
  recipe: BrewfatherRecipe,
  env: BrewfatherEnv,
): Promise<string[]> {
  const browser = await puppeteer.launch(env.MYBROWSER);
  const results: string[] = [];

  try {
    const page = await browser.newPage();

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

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    const itemsToSearch: SearchItem[] = [
      ...(recipe.fermentables || []).map((f) => ({
        name: f.name,
        qty: `${f.amount}kg`,
        desiredQuantity: f.amount,
      })),
      ...(recipe.hops || []).map((h) => ({
        name: h.name,
        qty: `${h.amount}g`,
        desiredQuantity: h.amount,
      })),
      ...(recipe.yeasts || []).map((y) => ({
        name: y.name,
        qty: "1 pkt",
        desiredQuantity: 1,
      })),
    ];

    for (const item of itemsToSearch) {
      try {
        const searchUrl = `https://www.themaltmiller.co.uk/?s=${encodeURIComponent(item.name)}&post_type=product`;
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        const firstProductSelector =
          ".products .product a.woocommerce-LoopProduct-link, article.product h2 a";
        const hasProduct = await page.$(firstProductSelector);

        if (hasProduct) {
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: 15000,
            }),
            page.click(firstProductSelector),
          ]);

          const quantitySelector = "form.cart input.qty, input[name='quantity']";
          const quantityField = await page.$(quantitySelector);
          let quantityNote = "";

          if (quantityField && item.desiredQuantity > 0) {
            const roundedQty = Math.max(1, Math.round(item.desiredQuantity));

            await page.evaluate(
              (selector, value) => {
                const el = document.querySelector(selector) as HTMLInputElement | null;
                if (el) {
                  el.value = String(value);
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                }
              },
              quantitySelector,
              roundedQty,
            );

            if (roundedQty !== item.desiredQuantity) {
              quantityNote = ` (rounded to ${roundedQty} — check pack size against ${item.qty})`;
            }
          } else if (item.desiredQuantity > 0) {
            quantityNote = " (quantity field not found — used site default)";
          }

          const addToCartBtn = "button.single_add_to_cart_button";
          if (await page.$(addToCartBtn)) {
            await page.click(addToCartBtn);
            await delay(1000);
            results.push(
              `✅ Added match for "${item.name}" (${item.qty})${quantityNote}`,
            );
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
    await browser.close();
  }
}

export const LOCAL_TOOLS = [
  {
    name: "get_brewfather_recipe",
    description:
      "Fetches fermentables, hops, and yeast from a Brewfather recipe ID.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: {
          type: "string",
          description: "The Brewfather Recipe ID",
        },
      },
      required: ["recipeId"],
    },
  },
  {
    name: "stage_malt_miller_cart",
    description:
      "Fetches a Brewfather recipe and automatically adds matching ingredients to The Malt Miller cart.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: {
          type: "string",
          description: "The Brewfather Recipe ID",
        },
      },
      required: ["recipeId"],
    },
  },
] as const;

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOL_NAMES.has(name);
}

export async function callLocalTool(
  name: string,
  args: Record<string, unknown> | undefined,
  env: BrewfatherEnv,
) {
  const recipeId = String(args?.recipeId ?? "");

  if (name === "get_brewfather_recipe") {
    try {
      const recipe = await fetchBrewfatherRecipe(
        recipeId,
        env.BREWFATHER_USER_ID,
        env.BREWFATHER_API_KEY,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(recipe, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }

  if (name === "stage_malt_miller_cart") {
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

      return { content: [{ type: "text", text: summary }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Automation failed: ${err.message}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown local tool: ${name}`);
}
