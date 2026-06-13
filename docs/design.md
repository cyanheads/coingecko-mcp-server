# coingecko-mcp-server — Design

Cryptocurrency market data via the live CoinGecko REST API (v3, keyless public tier). Read-only, single-source, local-only (CoinGecko ToS forbids redistribution — no hosted endpoint). One optional `COINGECKO_API_KEY` attaches the Demo-tier header; absent = keyless.

Probe-verified API shapes (the source of truth for service/output schemas) live in [`docs/api-probe-notes.md`](./api-probe-notes.md).

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `coingecko_search_coins` | Resolve a coin name or ticker symbol to a CoinGecko ID (slug). The required first step before any ID-keyed tool — CoinGecko keys data by slug (`bitcoin`, `ethereum`), not ticker (`BTC`, `ETH`), and tickers are not unique (many coins share `ETH`/`USDC`). Returns ranked matches with `id`, `symbol`, `name`, and `market_cap_rank` to disambiguate. | `query` (string) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_prices` | Current price and core market stats for one or more coins in one or more fiat/crypto currencies. Batch-friendly — pass a whole portfolio in one call (up to 250 IDs). IDs must be CoinGecko slugs; resolve unknown tickers with `coingecko_search_coins` first. Reports any requested IDs that returned no data (a wrong slug yields a silent miss upstream, not an error). | `ids` (string[], slugs, ≤250), `vs_currencies` (string[], default `["usd"]`) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_list_markets` | Ranked market table — top coins sorted by market cap, volume, or 24h price change, optionally filtered to a category. The entry point for "top 20 DeFi coins" or "biggest gainers today". Returns standard market fields per coin (price, cap, volume, supply, 24h/7d change, ATH/ATL). Discover valid category slugs with `coingecko_list_categories`. | `vs_currency` (string, default `usd`), `order` (enum), `category` (string?), `page`, `per_page` (≤250, default 50) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_coin` | Deep profile for a single coin: description, categories, genesis date, homepage/whitepaper/repo/social links, full market data (price, cap, supply, ATH/ATL, multi-window price change), developer activity (GitHub stars/forks/commits), community stats, and sentiment vote split. The full picture for "tell me everything about Ethereum". Use `sections` to fetch only part of the (large) record. | `id` (string, slug), `sections` (enum[]?) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_market_chart` | Historical price, market cap, and volume time series for a coin. Two modes: `recent` (last N days, granularity auto-scales — ≤1 day → ~5-min, 2–90 → hourly, >90 → daily) or `range` (explicit Unix-second from/to). Returns timestamped point arrays. Use for trend/charting questions, not the current snapshot (use `coingecko_get_prices`). | `id` (string, slug), `vs_currency` (default `usd`), `mode` (enum, default `recent`), `days`/`from`/`to` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_trending` | Coins (and NFTs) trending on CoinGecko in the last 24 hours, by search volume. No parameters — a heartbeat for "what's hot in crypto right now". Returns trending coins with rank, price, and 24h change. | _(none)_ | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_global` | Global crypto market snapshot: total market cap and 24h volume (in a chosen currency), BTC/ETH dominance, active-coin and active-market counts, ongoing ICOs, and 24h market-cap change. One call for the macro picture. No coin ID needed. | `vs_currency` (default `usd`) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_list_categories` | List CoinGecko's coin categories (`category_id` + display name) — the valid slugs for `coingecko_list_markets`'s `category` filter. ~800 categories; pass `name_contains` to filter the list locally by name (e.g. "defi", "layer 1", "gaming") instead of scanning all of them. | `name_contains` (string?) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

**Count: 8 tools.** All read-only and idempotent (live API, no mutation); all `openWorldHint: true` (external upstream). No destructive or catastrophic operations — the entire surface is read-only market data, so nothing is excluded on irreversibility grounds.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `coingecko://coin/{id}` | Deep coin record by slug — same data as `coingecko_get_coin` (full record), as injectable context. | None (single record) |
| `coingecko://global` | Global crypto market snapshot — same data as `coingecko_get_global`. | None (singleton) |

Both resources mirror tool data exactly, so tool-only clients lose nothing. Resources are a convenience for clients that support stable-URI injectable context.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `coingecko_coin_research` | Structures a full single-coin research pass — resolve the slug, pull deep metadata, sample recent price history, and frame it against the global market. Guides the agent through the search→get_coin→get_market_chart→get_global chain. | `coin` (string — name, ticker, or slug) |

One optional prompt. Skip-able; the tool surface is self-sufficient without it.

## Overview

`coingecko-mcp-server` exposes CoinGecko's v3 REST API to agents as a tight, workflow-shaped tool surface for cryptocurrency market data: live prices, ranked markets, deep coin metadata, historical series, trending, and global macro stats for 15,000+ coins. It is the crypto counterpart to the fleet's equities coverage (Finnhub) — no other fleet server covers crypto.

**Audience:** crypto investors/analysts, DeFi and crypto-adjacent tool builders, and AI workflows needing market context or coin research.

**Single source.** Every tool reads CoinGecko; there is no fallback chain or multi-source fan-out. The design challenge is not source routing but **ID resolution** — CoinGecko keys everything by slug, and the surface must make search-before-query obvious and recover gracefully from the silent-miss behavior of `/simple/price`.

**Local-only by ToS.** CoinGecko's Demo/free terms forbid storing, deriving, or redistributing their data; a hosted endpoint serving it is redistribution. The server stays local (`hostable: false`). The optional API key is a per-user throughput knob, never a hosting requirement. Attribution ("Data provided by CoinGecko") belongs in tool-output metadata and the README.

## Requirements

- **Read-only.** No writes, no mutation. Every tool is `readOnlyHint: true`.
- **Keyless by default; key optional.** No env var required to run. If `COINGECKO_API_KEY` is set, attach header `x-cg-demo-api-key: <key>` to every request for the dedicated Demo tier (10k calls/month, 100 req/min). Base URL is unchanged either way: `https://api.coingecko.com/api/v3`. (Pro keys, which switch the root to `pro-api.coingecko.com`, are out of scope.)
- **Rate limits.** Keyless shares an IP-throttled public pool — 429s arrive under light load (confirmed: ~8–10 rapid requests tripped it during probing). The service layer must back off and retry on 429 with calibrated delay. A Demo key materially raises the ceiling.
- **ID resolution is the core UX constraint.** Slugs (`bitcoin`), not tickers (`BTC`); tickers are non-unique. `coingecko_search_coins` is the documented first step; every ID-keyed tool's description points back to it.
- **Three upstream error shapes** (all probe-confirmed) must be handled distinctly — see Design Decisions.
- **Silent miss on `/simple/price`.** A bad/unknown slug returns `200 {}`, not an error; an unsupported currency returns the coin with that currency key absent. `coingecko_get_prices` must diff requested vs. returned and disclose the gap, or agents misread a typo'd slug as a nonexistent coin.
- **Attribution required** — surface "Data provided by CoinGecko" in output metadata and README.
- **Freshness** — CoinGecko updates ~every 60s; not real-time tick data. Document so agents don't expect sub-minute precision.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `coingecko` | CoinGecko REST API v3 (`api.coingecko.com/api/v3`); optional Demo-key header | All 8 tools, both resources, the prompt's underlying calls |

Single service, init/accessor pattern. Methods map to the endpoints the tools need (`search`, `simplePrice`, `coinsMarkets`, `coinDetail`, `marketChart` / `marketChartRange`, `trending`, `global`, `categoriesList`, optionally `supportedVsCurrencies` for input validation). Each method wraps the full fetch+parse pipeline in `withRetry`.

**Resilience** (per the skill's table):

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Service method wraps fetch + parse, not just the network call. `withRetry` from `/utils`. |
| Backoff calibration | 1–2s base (rate-limited upstream), honoring `Retry-After` when present on the 429. |
| HTTP status | `fetchWithTimeout` → non-OK throws; map via `httpErrorFromResponse` (captures body + `Retry-After`). 429 → `RateLimited` (retryable), 404 → `NotFound`. |
| Parse-failure classification | Response handler treats HTML/non-JSON error bodies as transient, not `SerializationError`. |
| Silent-miss detection | Not a retry concern — handled in `coingecko_get_prices`: cross-reference returned keys against requested `ids`, populate a `missing` field. |

**API-efficiency notes:** `/simple/price` is natively batch (≤250 ids) — `coingecko_get_prices` leans on it instead of N single fetches. `/coins/markets` paginates (`per_page` ≤250); the tool exposes `page`/`per_page` and discloses truncation. No `fields`-selection param exists upstream, so `coingecko_get_coin` trims at our layer via the trimming flags (`localization=false&tickers=false&sparkline=false`) plus an output `sections` selector.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `COINGECKO_API_KEY` | No | Optional CoinGecko **Demo** API key. Present → sent as `x-cg-demo-api-key` header for the dedicated Demo tier (10k/mo, 100 rpm). Absent → keyless public tier (shared, IP-throttled). Base URL unchanged. |

Lives in `src/config/server-config.ts` as its own Zod schema (`z.string().optional()`), parsed via `parseEnvConfig`. Both packaging files need the var declared if it's surfaced to install UX: `server.json` (`environmentVariables[]`, not required) and `manifest.json` (`user_config`, optional) — names must match (`lint:packaging`).

## Implementation Order

1. **Config + server setup** — `server-config.ts` (optional `COINGECKO_API_KEY`), `createApp()` identity (`name`/`title` both `coingecko-mcp-server`, `websiteUrl`, `description` from package.json, `instructions` noting search-first + slug-not-ticker), remove echo definitions.
2. **`coingecko` service** — base client (conditional Demo header), `withRetry` wrapper, `httpErrorFromResponse` mapping, response/parse handling, one method per endpoint, domain types from probe notes.
3. **Read-only tools, resolution-first order:** `coingecko_search_coins` → `coingecko_get_prices` → `coingecko_list_categories` → `coingecko_list_markets` → `coingecko_get_coin` → `coingecko_get_market_chart` → `coingecko_get_trending` → `coingecko_get_global`.
4. **Resources** — `coingecko://coin/{id}`, `coingecko://global` (thin wrappers over service methods the tools already use).
5. **Prompt** — `coingecko_coin_research`.
6. **Tests** — per tool/service via `createMockContext`; include at least one sparse-payload case (null `roi`, empty `links`, null community fields) and the `/simple/price` silent-miss case.

Each step is independently testable.

## Tool Detail

Per-tool input/output/error notes that drive scaffolding. Output schemas are designed for the agent's next action; every field gets `.describe()`. Upstream sparsity (probe-confirmed: `roi` often null, `community_data`/`links` frequently null/empty) means most nested coin fields are `.optional()`/`.nullable()` — do not fabricate values for missing upstream data.

### `coingecko_search_coins`
- **Input:** `query: z.string().min(1)` — coin name or ticker.
- **Output:** `coins: [{ id, symbol, name, marketCapRank?: number|null, thumb?: string }]` — `id` is the slug to chain into every other tool. Cap to a top slice (e.g. 25) with truncation disclosure via `ctx.enrich.truncated`.
- **Errors:** none domain-specific; empty `coins` is a valid result, not an error — `ctx.enrich.notice` ("no coin matched '<query>'; try a fuller name or the ticker"). 429 bubbles as `RateLimited`.

### `coingecko_get_prices`
- **Input:** `ids: z.array(z.string()).min(1).max(250)` (slugs), `vs_currencies: z.array(z.string()).default(['usd'])`, plus booleans defaulting true for market cap / 24h vol / 24h change / last-updated.
- **Output:** `prices: Record<id, Record<currency, { price, marketCap?, vol24h?, change24h? }>>` (or a flattened array of `{ id, currency, price, ... }` for easier `format()` parity), `lastUpdatedAt?: number` (Unix **seconds**), and **`missing: string[]`** — requested ids absent from the response. `format()` lists prices AND the missing ids.
- **Errors contract:** `{ reason: 'all_missing', code: NotFound, when: 'No requested ID returned data (all slugs unknown or upstream empty)', recovery: 'Resolve tickers to slugs with coingecko_search_coins, then retry.' }`. Partial misses are NOT an error — surfaced in `missing`. 429 → `RateLimited` (retryable).

### `coingecko_list_markets`
- **Input:** `vs_currency: z.string().default('usd')`, `order: z.enum(['market_cap_desc','market_cap_asc','volume_desc','volume_asc','price_change_percentage_24h_desc','price_change_percentage_24h_asc']).default('market_cap_desc')`, `category: z.string().optional()` (slug from `list_categories`), `page: z.number().int().min(1).default(1)`, `per_page: z.number().int().min(1).max(250).default(50)`. Always request `price_change_percentage=1h,24h,7d`.
- **Output:** `coins: [{ id, symbol, name, currentPrice, marketCap, marketCapRank, totalVolume, high24h, low24h, priceChangePercentage24h, priceChangePercentage1h?, priceChangePercentage7d?, circulatingSupply?, totalSupply?, maxSupply?, ath, athDate, atl, atlDate }]`. Disclose cap via `ctx.enrich.truncated({ shown, cap: per_page })` and echo the resolved order/category via `ctx.enrich`.
- **Errors contract:** `{ reason: 'unknown_category', code: InvalidParams, when: 'category slug not recognized by upstream (empty result with a category set)', recovery: 'List valid slugs with coingecko_list_categories and use category_id exactly.' }`. (Upstream returns empty rather than erroring on a bad category — detect empty-with-category and map to this.)

### `coingecko_get_coin`
- **Input:** `id: z.string().min(1)` (slug), `sections: z.array(z.enum(['profile','market','links','developer','community','sentiment'])).optional()` — omitted = all sections.
- **Output:** discriminated by section presence; fields: `profile { description?, categories[], genesisDate?, hashingAlgorithm?, countryOrigin? }`, `market { currentPriceUsd?, marketCapUsd?, ...supply, ath{price,date}, atl{price,date}, priceChangePct{24h,7d,30d,1y}? }`, `links { homepage[], whitepaper?, repos[], subreddit?, twitter?, telegram? }`, `developer { stars?, forks?, commits4w?, totalIssues?, closedIssues? }`, `community { redditSubscribers? }` (probe: `community_data` has `facebook_likes`, `reddit_average_posts_48h`, `reddit_average_comments_48h`, `reddit_subscribers`, `reddit_accounts_active_48h`, `telegram_channel_user_count` — **no `twitter_followers` field in `community_data`**; Twitter follower count is not returned by this endpoint), `sentiment { upPercentage?, downPercentage? }`. Always include `id`, `symbol`, `name`, plus attribution. **Probe note:** `categories` is an array of human-readable display names (e.g. `"Layer 1 (L1)"`), not slugs — different from the category_id slugs in `list_categories`. `market_data.current_price` is a per-currency dict (not a single number); extract the `vs_currency` key for a scalar. Sentiment fields are top-level on the coin object, not nested under `market_data` or `community_data`: `sentiment_votes_up_percentage`, `sentiment_votes_down_percentage`.
- **Errors contract:** `{ reason: 'coin_not_found', code: NotFound, when: 'Upstream 404 {"error":"coin not found"} for an unrecognized slug', recovery: 'Verify the slug with coingecko_search_coins — IDs are slugs (bitcoin), not tickers (BTC).' }`.
- **Note:** the full record is large (~tens of KB). `sections` is the primary trimming lever. If a single-section payload still overflows in practice, `outlineOnOverflow()` is the documented escalation (defer until measured).

### `coingecko_get_market_chart`
- **Input:** `id: z.string().min(1)`, `vs_currency: z.string().default('usd')`, `mode: z.enum(['recent','range']).default('recent')`, `days: z.union([z.number().int().min(1), z.literal('max')]).optional()` (recent mode), `from`/`to: z.number().int().optional()` (Unix **seconds**, range mode). Validate the mode/param pairing in-handler.
- **Output:** `prices: [{ t: number /* ms */, value: number }]`, `marketCaps: [...]`, `volumes: [...]`, `granularity: 'minutely'|'hourly'|'daily'` (computed/disclosed), `pointCount`. `format()` summarizes (range, point count, granularity, first/last value) rather than dumping every point. **Timestamps are milliseconds** (unlike `/simple/price`'s seconds — note in the field `.describe()`).
- **Errors contract:** `{ reason: 'coin_not_found', code: NotFound, when: 'Upstream 404 for unknown slug', recovery: 'Resolve the slug via coingecko_search_coins first.' }`, `{ reason: 'invalid_range', code: InvalidParams, when: 'range mode without both from and to, or recent mode without days', recovery: 'For mode=recent pass days; for mode=range pass both from and to as Unix seconds.' }`.

### `coingecko_get_trending`
- **Input:** none.
- **Output:** `coins: [{ id, name, symbol, marketCapRank?, priceUsd?, priceBtc?, priceChangePercentage24hUsd? }]`. Map from the nested `coins[].item.{...,data:{...}}` shape; pull USD out of the per-currency `price_change_percentage_24h` map. **Quirk (probe-confirmed):** trending's `data.market_cap`/`total_volume` are pre-formatted display strings (e.g. `"$92,219,216"`, `total_volume_btc` is also a string) — surface only the numeric `data.price` (float) and the USD slice of `data.price_change_percentage_24h` (dict keyed by currency code including `"usd"`) and drop or label-as-string the rest. Optionally include `nfts` count. Item-level fields available: `id, coin_id, name, symbol, market_cap_rank, thumb, small, large, slug, price_btc, score, data`.
- **Errors:** none domain-specific; 429 bubbles.

### `coingecko_get_global`
- **Input:** `vs_currency: z.string().default('usd')` (selects which key to read from the per-currency maps).
- **Output:** `totalMarketCap: number` (in chosen currency), `totalVolume24h: number`, `btcDominance: number` (`market_cap_percentage.btc`), `ethDominance: number`, `activeCryptocurrencies: number`, `markets: number`, `ongoingIcos: number`, `marketCapChangePercentage24h: number` (field: `market_cap_change_percentage_24h_usd` — note: always USD-denominated regardless of `vs_currency`), `updatedAt: number` (Unix s). Unwrap the `data` envelope. **Probe-confirmed extra field:** `volume_change_percentage_24h_usd` is also present and useful — include as `volumeChangePercentage24h: number`.
- **Errors:** none domain-specific.

### `coingecko_list_categories`
- **Input:** `name_contains: z.string().optional()` — local filter (MCP-side list filtering: bounded ~800-item set, no native upstream search, opaque-ish slugs, filters the natural lookup key = name).
- **Output:** `categories: [{ categoryId, name }]`, disclose truncation/total via `ctx.enrich.total`. Filter the **complete** fetched list (not a page) with strict token match (lowercase, strip punctuation, all query tokens present). No fuzzy fallback (an LLM caller rarely needs typo tolerance; a bare empty result with "browse unfiltered" guidance beats an approximate guess).
- **Errors:** none domain-specific; empty filtered result → `ctx.enrich.notice`.

## Design Decisions

1. **8 tools, goal-first, not an endpoint mirror.** CoinGecko exposes 40+ endpoints; the surface maps the 8 user goals from the brief. `/coins/list` (full dump) is dropped — `coingecko_search_coins` covers slug resolution better, and a 15k-row dump is not an agent workflow. `/exchanges` is dropped from v1 — exchange/ticker data serves a narrower audience than the price/market/research spine; defer until demand. The two richer historical endpoints collapse into one `coingecko_get_market_chart` with a `mode` enum (recent days vs. explicit Unix range) rather than two tools on the same noun.

2. **Search-before-query is enforced through descriptions, not structure.** Every ID-keyed tool's description states slugs-not-tickers and points to `coingecko_search_coins`. The server's `instructions` repeats it once at session level. This is the dominant UX risk and the cheapest place to fix it is the prose the model reads before calling.

3. **`/simple/price` silent miss → explicit `missing` field + `all_missing` error.** Probe-confirmed: a wrong slug returns `200 {}` and a bad currency returns `{"coin":{}}` — no upstream error. Without handling, an agent reads a typo as "coin doesn't exist." `coingecko_get_prices` diffs requested ids against returned keys: partial misses populate `missing` (a normal result the agent can act on by re-resolving); a total miss throws the typed `all_missing` (NotFound) with recovery pointing at search. This is the server reporting what only it can know (which ids the upstream omitted), leaving the agent to decide intent.

4. **Three upstream error envelopes, mapped distinctly.** (a) `/coins/{bad}` → `404 {"error":"coin not found"}` → `coin_not_found` (NotFound). (b) Over-quota → `429 {"status":{"error_code":429,...}}` → `RateLimited` (retryable, honor `Retry-After`). (c) `/simple/price` bad id → `200 {}` → not an error, handled as decision 3. The service's response handler keys off HTTP status + body shape since the two JSON error forms differ (`error` string vs. `status` object).

5. **`coingecko_list_categories` uses MCP-side list filtering, not DataCanvas.** The category list is bounded (~827), has no native upstream search, and the agent's job is name→slug resolution over categorical metadata — the textbook case for a local `name_contains` filter (strict token match over the complete list), explicitly *not* a DataCanvas surface (categorical discovery fails the "an agent would SQL it" gate). It exists to feed `coingecko_list_markets`'s `category` param, which agents otherwise can't populate.

6. **DataCanvas deferred for v1.** `/coins/markets` (≤250 rows) and `market_chart` (up to ~daily-over-max points) are mildly analytical, and the idea brief flags canvas as "useful." But: (a) a paged 250-row market table fits context and is a discovery surface more than an aggregate-over surface; (b) opting into canvas makes a paired `coingecko_dataframe_query` tool *mandatory* (a `canvas_id` with no query tool is dead output), expanding the surface for marginal v1 value; (c) keeping it out preserves install-and-go simplicity and Workers portability. Revisit if market/chart pulls prove large enough that agents want SQL over them. Recorded as a deliberate scope cut, not an oversight.

7. **Timestamp-unit inconsistency surfaced in schemas.** `/simple/price.last_updated_at` and `/global.updated_at` are Unix **seconds**; `market_chart` point timestamps are **milliseconds**. Both are passed through as-is (no normalization to a single unit — agents chaining to other fleet servers may want either), but each field's `.describe()` states its unit explicitly so the model doesn't misread a ms timestamp as seconds.

8. **Trending's mixed-type payload normalized to trustworthy numbers.** `/search/trending` returns `data.price` as a float but `data.market_cap`/`total_volume`/`total_volume_btc` as pre-formatted display strings (e.g. `"$92,219,216"`, probe-confirmed), and `price_change_percentage_24h` as a dict keyed by currency code (e.g. `{"usd": -75.2, "eur": ..., ...}`) — not a single number, and not `{usd: number}` in a wrapper object. `coingecko_get_trending` surfaces the numeric `data.price` and `data.price_change_percentage_24h["usd"]`; the string-formatted cap/volume are dropped (or relabeled as opaque strings) rather than passed off as numeric data — don't fabricate numeric signal from display strings.

9. **Local-only, optional-key honored end to end.** `COINGECKO_API_KEY` is `z.string().optional()` — the server runs with zero config (keyless), and the only effect of the key is the conditional `x-cg-demo-api-key` header. No code path requires it; no hosting depends on it (ToS forbids hosting regardless). Pro-tier (different base URL) is explicitly out of scope.

10. **Attribution as a first-class output concern.** CoinGecko's ToS requires "Data provided by CoinGecko" attribution. Surface it in tool-output metadata (an `attribution` field or enrichment notice) and the README, so downstream consumers carry it.

## Known Limitations

- **Public-tier throttling.** Keyless requests share an IP-throttled pool; bursty multi-tool workflows will hit 429s (confirmed during probing at ~8–10 rapid calls). A free Demo key is the fix, but it is the user's to provision — the server can retry/back off but cannot raise the ceiling itself.
- **Not real-time.** ~60s freshness; no tick-level data. Fine for research/monitoring, not trading execution.
- **No hosted endpoint, ever.** ToS forbids redistribution — the server is local-only by design, not by missing work.
- **Ticker ambiguity is upstream-inherent.** Many coins share a symbol; `coingecko_search_coins` ranks by relevance/`market_cap_rank` but cannot guarantee the agent's intended coin — the agent must pick from ranked candidates.

## API Reference (essentials)

- **Base:** `https://api.coingecko.com/api/v3` (keyless and Demo). Demo header: `x-cg-demo-api-key`.
- **IDs are slugs** (`bitcoin`), resolved via `/search`. `vs_currency`/`vs_currencies` from a 63-entry supported set (`/simple/supported_vs_currencies`).
- **Pagination:** `/coins/markets` via `page` + `per_page` (≤250). `/simple/price` batches ≤250 ids, no pagination.
- **Historical granularity** auto-scales with range (≤1d ~5-min, 2–90d hourly, >90d daily); 5-min/hourly capped ~1 year on Demo tier.
- **`/global` fields:** `market_cap_change_percentage_24h_usd` and `volume_change_percentage_24h_usd` are both present (always USD-denominated). `total_market_cap`/`total_volume`/`market_cap_percentage` are per-currency/per-coin dicts — extract by key.
- **Error shapes:** `404 {"error":"..."}`, `429 {"status":{"error_code","error_message"}}`, and `200 {}`/`{"coin":{}}` silent miss on `/simple/price`.

Full probe-verified field listings: [`docs/api-probe-notes.md`](./api-probe-notes.md).
