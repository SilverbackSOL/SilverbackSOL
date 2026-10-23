# Protein Quest food lookup Worker

A Cloudflare Worker that turns a food description into per-item macros for the Protein Quest app.
It keeps the API keys off your phone.

How a lookup works:

1. Claude splits the text ("8 oz grilled chicken, 1 cup rice, a Core Power") into items and
   estimates grams and macros for each one.
2. Plain foods are re-priced from **USDA FoodData Central**, packaged foods from **Open Food Facts**.
3. Restaurant dishes, and any database match that looks like the wrong food, keep Claude's estimate.
   The app labels every row with where its number came from.

## One-time setup (about 15 minutes)

You need a free Cloudflare account and an Anthropic API key (console.anthropic.com).

```bash
cd protein-quest/worker
npm install
npx wrangler login                          # opens a browser to sign in to Cloudflare

npx wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic key
npx wrangler secret put APP_TOKEN           # paste any long random string, e.g. from: openssl rand -hex 24
npx wrangler secret put USDA_API_KEY        # optional: free key from https://fdc.nal.usda.gov/api-key-signup

npx wrangler deploy
```

`deploy` prints the Worker URL, like `https://protein-quest-lookup.<you>.workers.dev`.

In the app, open **Settings → Food lookup**, paste the URL and the same APP_TOKEN, and tap
**Save and test**. It should say "Connected. Lookups are ready."

Without `USDA_API_KEY` the Worker uses USDA's shared `DEMO_KEY`, which allows only about 30
lookups an hour. The free personal key allows 1,000 an hour.

## Locking it down

- **APP_TOKEN** is required on every lookup. If it leaks, set a new one with
  `npx wrangler secret put APP_TOKEN` and update the app.
- **Rate limit:** at most 30 lookups a minute (`[[ratelimits]]` in `wrangler.toml`).
- **Allowed origins:** once you know where the app is hosted, set `ALLOWED_ORIGINS` in
  `wrangler.toml` to that origin (for GitHub Pages, `https://silverbacksol.github.io`) and redeploy.

## Cost

Each lookup is one short Claude request at low effort, roughly a cent or less. USDA and
Open Food Facts are free.

## Local development

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-...\nAPP_TOKEN=dev\n' > .dev.vars   # git-ignored
npm run dev                                                          # http://localhost:8787
curl -s localhost:8787/estimate -H 'Authorization: Bearer dev' \
  -H 'Content-Type: application/json' -d '{"text":"2 eggs and a cup of greek yogurt"}'
npm run check                                                        # typecheck
```

## API

`POST /estimate` with `Authorization: Bearer <APP_TOKEN>` and `{"text": "..."}` (500 characters max).

```json
{
  "items": [
    { "name": "Grilled chicken breast", "amount": "8 oz", "grams": 227,
      "protein": 70.4, "carbs": 0, "fat": 8.2, "kcal": 375,
      "source": "usda", "match": "Chicken, broiler, breast, roasted", "confidence": "high" }
  ],
  "totals": { "protein": 70.4, "carbs": 0, "fat": 8.2, "kcal": 375 }
}
```

`source` is `usda`, `off` (Open Food Facts) or `ai`. `GET /health` returns `{"ok": true}`.
