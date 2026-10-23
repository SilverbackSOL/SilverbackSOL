// Protein Quest food lookup: turns "8 oz grilled chicken and a cup of rice" into per-item macros.
// Claude splits the description into items and estimates each one; plain foods are then
// re-priced from USDA FoodData Central and packaged foods from Open Food Facts, so the AI
// number is only kept when no database match looks right. All API keys stay in this Worker.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export interface Env {
  ANTHROPIC_API_KEY: string;
  APP_TOKEN: string;
  USDA_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

const MAX_TEXT = 500;

const Macros = z.object({
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  kcal: z.number(),
});
type Macros = z.infer<typeof Macros>;

const Parsed = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      amount: z.string(),
      grams: z.number(),
      kind: z.enum(["generic", "branded", "restaurant"]),
      lookup: z.string(),
      estimate: Macros,
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});
type ParsedItem = z.infer<typeof Parsed>["items"][number];

export interface Item extends Macros {
  name: string;
  amount: string;
  grams: number;
  source: "usda" | "off" | "ai";
  match: string | null;
  confidence: "high" | "medium" | "low";
}

const SYSTEM = `You split a food log entry into individual foods and estimate their macros.

For each food return:
- name: short display name ("Grilled chicken breast")
- amount: the portion as the user said it, or your assumption if they gave none ("8 oz", "1 cup", "1 bowl")
- grams: estimated edible weight in grams of that portion (cooked weight for cooked foods)
- kind: "generic" for plain whole foods and simple ingredients, "branded" for a named packaged product, "restaurant" for a named restaurant or chain dish or a mixed home-cooked dish
- lookup: a search phrase for a nutrition database. For generic foods use USDA-style wording ("Chicken, broilers or fryers, breast, meat only, cooked, roasted"); for branded foods use brand plus product ("Fairlife Core Power chocolate"); for restaurant dishes repeat the name
- estimate: protein, carbs and fat in grams and energy in kcal for the whole portion
- confidence: how sure you are of the estimate

Assume typical US portions when none is given. If the text is not food, return an empty items list.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname !== "/estimate" || request.method !== "POST") return json({ error: "Not found" }, 404, cors);

    if (!env.APP_TOKEN || !sameToken(request.headers.get("Authorization") ?? "", `Bearer ${env.APP_TOKEN}`)) {
      return json({ error: "Wrong or missing app token" }, 401, cors);
    }
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: "estimate" });
      if (!success) return json({ error: "Too many lookups, try again in a minute" }, 429, cors);
    }

    let text = "";
    try {
      text = String(((await request.json()) as { text?: unknown }).text ?? "").trim();
    } catch {
      return json({ error: "Send JSON like {\"text\": \"2 eggs\"}" }, 400, cors);
    }
    if (!text) return json({ error: "Describe the food first" }, 400, cors);
    if (text.length > MAX_TEXT) return json({ error: `Keep it under ${MAX_TEXT} characters` }, 400, cors);

    let parsed: ParsedItem[];
    try {
      parsed = await parseWithClaude(text, env);
    } catch (err) {
      return json({ error: claudeErrorMessage(err) }, 502, cors);
    }

    const items = await Promise.all(parsed.map((p) => price(p, env)));
    const totals = items.reduce(
      (t, i) => ({ protein: t.protein + i.protein, carbs: t.carbs + i.carbs, fat: t.fat + i.fat, kcal: t.kcal + i.kcal }),
      { protein: 0, carbs: 0, fat: 0, kcal: 0 },
    );
    return json({ items, totals: roundMacros(totals) }, 200, cors);
  },
};

async function parseWithClaude(text: string, env: Env): Promise<ParsedItem[]> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Parsed) },
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to estimate that entry");
  if (!response.parsed_output) throw new Error("Claude's answer could not be read");
  return response.parsed_output.items;
}

function claudeErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Worker's Anthropic API key is invalid";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limited, try again shortly";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}`.trim();
  return err instanceof Error ? err.message : "Estimate failed";
}

// Swap the AI estimate for database numbers when a match is found and looks like the same food.
async function price(p: ParsedItem, env: Env): Promise<Item> {
  const base = { name: p.name, amount: p.amount, grams: Math.round(p.grams), confidence: p.confidence };
  const ai: Item = { ...base, ...roundMacros(p.estimate), source: "ai", match: null };
  if (p.grams <= 0 || p.kind === "restaurant") return ai;

  const hit = p.kind === "generic" ? await usda(p.lookup, env) : await openFoodFacts(p.lookup);
  if (!hit) return ai;

  const scaled = scale(hit.per100g, p.grams);
  if (!plausible(scaled, p.estimate)) return ai;
  return { ...base, ...roundMacros(scaled), source: p.kind === "generic" ? "usda" : "off", match: hit.name, confidence: "high" };
}

// A wrong database hit ("rice" -> rice flour) shows up as macros far from Claude's own estimate.
function plausible(db: Macros, est: Macros): boolean {
  const close = (a: number, b: number, floor: number) => Math.max(a, b) < floor || (a / Math.max(b, 0.1) < 2.5 && b / Math.max(a, 0.1) < 2.5);
  return close(db.protein, est.protein, 5) && close(db.kcal, est.kcal, 60);
}

function scale(per100g: Macros, grams: number): Macros {
  const f = grams / 100;
  return { protein: per100g.protein * f, carbs: per100g.carbs * f, fat: per100g.fat * f, kcal: per100g.kcal * f };
}

function roundMacros(m: Macros): Macros {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { protein: r(m.protein), carbs: r(m.carbs), fat: r(m.fat), kcal: Math.round(m.kcal) };
}

interface DbHit {
  name: string;
  per100g: Macros;
}

// USDA nutrient numbers: 203 protein, 204 fat, 205 carbs, 208 kcal (957/958 are Atwater kcal on Foundation foods).
async function usda(query: string, env: Env): Promise<DbHit | null> {
  const params = new URLSearchParams({
    api_key: env.USDA_API_KEY || "DEMO_KEY",
    query,
    dataType: "Foundation,SR Legacy",
    pageSize: "3",
  });
  try {
    const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      foods?: { description: string; foodNutrients?: { nutrientNumber?: string; value?: number }[] }[];
    };
    const food = data.foods?.[0];
    if (!food?.foodNutrients) return null;
    const n = (num: string) => food.foodNutrients!.find((x) => x.nutrientNumber === num)?.value;
    const protein = n("203");
    if (protein === undefined) return null;
    const carbs = n("205") ?? 0;
    const fat = n("204") ?? 0;
    const kcal = n("208") ?? n("958") ?? n("957") ?? protein * 4 + carbs * 4 + fat * 9;
    return { name: food.description, per100g: { protein, carbs, fat, kcal } };
  } catch {
    return null;
  }
}

async function openFoodFacts(query: string): Promise<DbHit | null> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    json: "1",
    page_size: "3",
    fields: "product_name,brands,nutriments",
  });
  try {
    const res = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?${params}`, {
      headers: { "User-Agent": "ProteinQuest/1.0 (personal meal-plan tracker)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      products?: { product_name?: string; brands?: string; nutriments?: Record<string, number | string | undefined> }[];
    };
    const product = data.products?.find((p) => typeof p.nutriments?.proteins_100g === "number");
    if (!product?.nutriments) return null;
    const v = (k: string) => Number(product.nutriments![k] ?? 0) || 0;
    const protein = v("proteins_100g");
    const carbs = v("carbohydrates_100g");
    const fat = v("fat_100g");
    const kcal = v("energy-kcal_100g") || protein * 4 + carbs * 4 + fat * 9;
    const name = [product.brands?.split(",")[0], product.product_name].filter(Boolean).join(" ");
    return { name: name || query, per100g: { protein, carbs, fat, kcal } };
  } catch {
    return null;
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
