export interface BrewfatherEnv {
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
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

interface BrewfatherBatch {
  _id: string;
  name: string;
  batchNo?: number;
  status: string;
  recipe: BrewfatherRecipe;
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

async function fetchPendingBatches(
  userId: string,
  apiKey: string,
): Promise<BrewfatherBatch[]> {
  const credentials = btoa(`${userId}:${apiKey}`);
  const response = await fetch(
    `https://api.brewfather.app/v2/batches?status=Planning&complete=True&limit=50`,
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

  return (await response.json()) as BrewfatherBatch[];
}

function findBatchesByRecipeName(
  batches: BrewfatherBatch[],
  recipeName: string,
): BrewfatherBatch[] {
  const needle = recipeName.trim().toLowerCase();
  return batches.filter((b) =>
    (b.recipe?.name ?? "").toLowerCase().includes(needle),
  );
}

function formatIngredients(recipe: BrewfatherRecipe): string {
  const fermentables =
    (recipe.fermentables || [])
      .map((f) => `- ${f.name}: ${f.amount}kg`)
      .join("\n") || "  (none)";
  const hops =
    (recipe.hops || []).map((h) => `- ${h.name}: ${h.amount}g`).join("\n") ||
    "  (none)";
  const yeasts =
    (recipe.yeasts || []).map((y) => `- ${y.name}`).join("\n") || "  (none)";

  return `Fermentables:\n${fermentables}\n\nHops:\n${hops}\n\nYeast:\n${yeasts}`;
}

interface ShoppingLinkItem {
  name: string;
  qty: string;
  searchUrl: string;
}

/**
 * NOTE: Automated cart-filling via a headless browser was tried and
 * abandoned — The Malt Miller sits behind Cloudflare bot-protection,
 * which challenges every headless session before it can reach real
 * search results (see PR #24 for the diagnostic evidence). Rather than
 * attempt to defeat that protection, this generates one direct search
 * link per ingredient for the person to open and add to their cart
 * themselves. This also avoids needing any Malt Miller account/API
 * credentials at all — the flow never touches login, payment, or
 * checkout in any way.
 */
function buildShoppingLinks(recipe: BrewfatherRecipe): ShoppingLinkItem[] {
  const items: { name: string; qty: string }[] = [
    ...(recipe.fermentables || []).map((f) => ({
      name: f.name,
      qty: `${f.amount}kg`,
    })),
    ...(recipe.hops || []).map((h) => ({
      name: h.name,
      qty: `${h.amount}g`,
    })),
    ...(recipe.yeasts || []).map((y) => ({
      name: y.name,
      qty: "1 pkt",
    })),
  ];

  return items.map((item) => ({
    ...item,
    searchUrl: `https://www.themaltmiller.co.uk/?s=${encodeURIComponent(item.name)}&post_type=product`,
  }));
}

function formatShoppingList(recipe: BrewfatherRecipe): string {
  const links = buildShoppingLinks(recipe);
  return links
    .map((item) => `- ${item.name} (${item.qty}): ${item.searchUrl}`)
    .join("\n");
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
      "Fetches a Brewfather recipe and returns a direct Malt Miller search link per ingredient, for manually adding items to the cart. Does not use any Malt Miller account, login, or payment credentials — it only ever generates read-only search links.",
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
    name: "find_pending_batch_by_recipe_name",
    description:
      "Finds a pending (Planning status) Brewfather batch by recipe name and lists its ingredients. Returns the recipeId so it can be passed to stage_malt_miller_cart to get shopping links.",
    inputSchema: {
      type: "object",
      properties: {
        recipeName: {
          type: "string",
          description:
            "The recipe name to search for among pending batches (case-insensitive, partial match).",
        },
      },
      required: ["recipeName"],
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
      const shoppingList = formatShoppingList(recipe);

      const summary = `
Shopping list for "${recipe.name}"

The Malt Miller sits behind bot-protection that blocks automated cart-filling, so here's a direct search link per ingredient — open each and add it to your cart in one click:

${shoppingList}

No Malt Miller account, login, or payment details are used at any point — these are plain search links only.
      `.trim();

      return { content: [{ type: "text", text: summary }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to build shopping list: ${err.message}` }],
        isError: true,
      };
    }
  }

  if (name === "find_pending_batch_by_recipe_name") {
    try {
      if (!env.BREWFATHER_USER_ID || !env.BREWFATHER_API_KEY) {
        throw new Error(
          "Missing Brewfather credentials in Cloudflare secrets.",
        );
      }

      const recipeName = String(args?.recipeName ?? "").trim();
      if (!recipeName) {
        throw new Error("recipeName is required");
      }

      const batches = await fetchPendingBatches(
        env.BREWFATHER_USER_ID,
        env.BREWFATHER_API_KEY,
      );
      const matches = findBatchesByRecipeName(batches, recipeName);

      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No pending (Planning) batches found matching recipe name "${recipeName}".`,
            },
          ],
          isError: true,
        };
      }

      if (matches.length > 1) {
        const list = matches
          .map(
            (b) =>
              `- "${b.name}" (batch #${b.batchNo ?? "?"}, recipe: "${b.recipe.name}", recipeId: ${b.recipe._id})`,
          )
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Multiple pending batches matched "${recipeName}":\n${list}\n\nPlease specify more precisely, or pass one of the recipeIds above to stage_malt_miller_cart.`,
            },
          ],
        };
      }

      const batch = matches[0];
      const recipe = batch.recipe;

      const summary = `
Pending batch found: "${batch.name}" (Batch #${batch.batchNo ?? "?"}, status: ${batch.status})
Recipe: "${recipe.name}" (recipeId: ${recipe._id})

${formatIngredients(recipe)}

To get Malt Miller shopping links for these ingredients, call stage_malt_miller_cart with recipeId "${recipe._id}".
      `.trim();

      return { content: [{ type: "text", text: summary }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown local tool: ${name}`);
}
