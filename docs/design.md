# coingecko-mcp-server — Design

Cryptocurrency market data via the live CoinGecko REST API (v3, keyless public tier). Read-only, single-source, local-only (CoinGecko ToS forbids redistribution — no hosted endpoint). One optional `COINGECKO_API_KEY` attaches the Demo-tier header; absent = keyless.

Probe-verified API shapes (the source of truth for service/output schemas) live in [`docs/api-probe-notes.md`](./api-probe-notes.md).

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `coingecko_search_coins` | Resolve names and tickers to ranked slug candidates or look up one token by platform and contract. | `query` or `platform` and `contract_address` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_prices` | Current prices and core market stats across coin/currency batches. Normalize and deduplicate inputs, process up to 250 unique IDs, and disclose skipped IDs separately from upstream misses. | `ids` (≤500 raw, first 250 unique), `vs_currencies` (default `["usd"]`) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_list_markets` | Ranked market table sorted by market cap, volume, or ID, optionally selected by category or IDs. Discover category slugs with `coingecko_list_categories`. | `vs_currency`, `order`, `category?` or `ids?` (≤500 raw, first 250 unique), `page`, `per_page` (≤250, default 50) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_coin` | Coin profile, market data, platform contracts, links, developer activity, community, and sentiment. Use `sections` to select the output. | `id`, `vs_currency?`, `sections?` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_market_chart` | Exact pages of historical price, market cap, and volume observations. Recent windows cover up to 365 days; range windows use Unix-second from/to. Cadence is measured from the complete original price series. | `id`, `vs_currency`, `mode`, `days`/`from`/`to`, `interval` (auto/daily/hourly), `point_offset`, `point_limit` (default 100, cap 250) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_trending` | Coins (and NFTs) trending on CoinGecko in the last 24 hours, by search volume. No parameters — a heartbeat for "what's hot in crypto right now". Returns trending coins with rank, price, and 24h change. | _(none)_ | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_get_global` | Global market cap, volume, dominance, Fear & Greed index, active counts, and 24h changes. | `vs_currency` (default `usd`) | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `coingecko_list_categories` | Browse the category catalog or rank categories by aggregate market data. Both modes support name filtering. | `name_contains?`, `include_market_data?`, `order?`, `min_market_cap?`, `limit?`, `offset?` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

**Count: 8 tools.** All read-only and idempotent (live API, no mutation); all `openWorldHint: true` (external upstream). No destructive or catastrophic operations — the entire surface is read-only market data, so nothing is excluded on irreversibility grounds.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `coingecko://coin/{id}` | Deep coin record by slug — same data as `coingecko_get_coin` (full record), as injectable context. | None (single record) |
| `coingecko://global` | Global crypto market snapshot — same data as `coingecko_get_global`. | None (singleton) |

Both resources mirror tool data exactly, so tool-only clients lose nothing. Resources are a convenience for clients that support stable-URI injectable context.

The coin resource decodes its URI component once before trimming and lowercasing. Malformed percent escapes fail parameter validation; decoded IDs are encoded again only when forming the upstream path.

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
- **Coin IDs are slugs.** Pass a known slug directly or use `coingecko_search_coins` to resolve a name, ticker, or platform-specific contract.
- **Three upstream error shapes** (all probe-confirmed) must be handled distinctly — see Design Decisions.
- **Silent miss on `/simple/price`.** A bad/unknown slug returns `200 {}`, not an error; an unsupported currency returns the coin with that currency key absent. `coingecko_get_prices` must diff requested vs. returned and disclose the gap, or agents misread a typo'd slug as a nonexistent coin.
- **Attribution required** — surface "Data provided by CoinGecko" in output metadata and README.
- **Freshness** — CoinGecko updates ~every 60s; not real-time tick data. Document so agents don't expect sub-minute precision.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `coingecko` | CoinGecko REST API v3 (`api.coingecko.com/api/v3`); optional Demo-key header | All 8 tools, both resources, the prompt's underlying calls |

Single service, init/accessor pattern. Methods map to the endpoints the tools need (`search`, `simplePrice`, `coinsMarkets`, `coinDetail`, `marketChart` / `marketChartRange`, `trending`, `global`, `categoriesList`). Coin detail conditionally queries `/simple/supported_vs_currencies` for market-selected missing quote keys. Each request wraps the full fetch+parse pipeline in `withRetry`.

**Resilience** (per the skill's table):

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Service method wraps fetch + parse, not just the network call. `withRetry` from `/utils`. |
| Coin-detail budget | One framework deadline of 50 seconds surrounds the primary request and conditional currency lookup. Each request retains existing retries/backoff; the outer deadline adds no retry of the whole sequence. |
| Backoff calibration | 1–2s base (rate-limited upstream), honoring `Retry-After` when present on the 429. |
| HTTP status | `fetchWithTimeout` classifies non-OK statuses and captures body + `Retry-After`. Preserve its code and retry decision: permanent code-specific reasons, separate timeout, 429 `rate_limited`, transient 5xx `upstream_unreachable`, permanent 501 `upstream_http_error`. Caller cancellation passes unchanged. |
| Parse-failure classification | Response handler treats HTML/non-JSON error bodies as transient, not `SerializationError`. |
| Silent-miss detection | Not a retry concern — handled in `coingecko_get_prices`: cross-reference returned keys against requested `ids`, populate a `missing` field. |

**API-efficiency notes:** `/simple/price` is natively batch (≤250 ids) — `coingecko_get_prices` leans on it instead of N single fetches. `/coins/markets` paginates (`per_page` ≤250); the tool exposes `page`/`per_page` and discloses truncation. No `fields`-selection param exists upstream, so `coingecko_get_coin` trims at our layer via the trimming flags (`localization=false&tickers=false&sparkline=false`) plus an output `sections` selector.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `COINGECKO_API_KEY` | No | Optional CoinGecko **Demo** API key. Present → sent as `x-cg-demo-api-key` header for the dedicated Demo tier (10k/mo, 100 rpm). Absent → keyless public tier (shared, IP-throttled). Base URL unchanged. |

Lives in `src/config/server-config.ts` as its own Zod schema (`z.string().optional()`), parsed via `parseEnvConfig`. Both packaging files need the var declared if it's surfaced to install UX: `server.json` (`environmentVariables[]`, not required) and `manifest.json` (`user_config`, optional) — names must match (`lint:packaging`).

## Implementation Order

1. **Config and server setup** — `server-config.ts` (optional `COINGECKO_API_KEY`), `createApp()` identity (`name`/`title` both `coingecko-mcp-server`, `websiteUrl`, and `description` from package.json), and session instructions for slug resolution.
2. **`coingecko` service** — base client (conditional Demo header), `withRetry` wrapper, `httpErrorFromResponse` mapping, response/parse handling, one method per endpoint, domain types from probe notes.
3. **Read-only tools, resolution-first order:** `coingecko_search_coins` → `coingecko_get_prices` → `coingecko_list_categories` → `coingecko_list_markets` → `coingecko_get_coin` → `coingecko_get_market_chart` → `coingecko_get_trending` → `coingecko_get_global`.
4. **Resources** — `coingecko://coin/{id}`, `coingecko://global` (thin wrappers over service methods the tools already use).
5. **Prompt** — `coingecko_coin_research`.
6. **Tests** — per tool/service via `createMockContext`; include at least one sparse-payload case (null `roi`, empty `links`, null community fields) and the `/simple/price` silent-miss case.

Each step is independently testable.

## Tool Detail

Per-tool input/output/error notes that drive scaffolding. Output schemas are designed for the agent's next action; every field gets `.describe()`. Upstream sparsity (probe-confirmed: `roi` often null, `community_data`/`links` frequently null/empty) means most nested coin fields are `.optional()`/`.nullable()` — do not fabricate values for missing upstream data.

### `coingecko_search_coins`
- **Input.** Pass `query` for a name or ticker, or both `platform` and `contract_address`. Contract resolution uses `/coins/{platform}/contract/{address}` and preserves address case.
- **Output.** `coins: [{ id, symbol, name, marketCapRank?, thumb? }]`. Name/ticker search returns up to 25 ranked candidates with truncation disclosed. Contract search returns one candidate.
- **Errors.** Reject partial, mixed, or missing selectors before fetching. Contract HTTP 404 maps to `contract_not_found`. An empty query result carries narrowing guidance.

### `coingecko_get_prices`
- **Input.** `ids` accepts up to 500 raw entries. Split IDs and currencies on commas, trim, lowercase, drop empty tokens, and deduplicate in first-seen order. Process the first 250 unique IDs and disclose the rest as `skippedIds`. Empty normalized inputs fail. `vs_currencies` defaults to `['usd']`.
- **Output.** `prices` contains flat rows with ID, currency, price, and optional market cap, volume, 24h change, and `lastUpdatedAtUnixSec`. The optional batch timestamp of the same name is the oldest reported timestamp among emitted rows. `missing` lists processed IDs absent from the upstream response.
- **Errors contract:** `all_missing` (NotFound) when all processed IDs are absent; `no_price_data` (NotFound) when IDs resolve but no requested currency has numeric quotes. Partial misses populate `missing`; absent quotes alone do not establish an unsupported currency. 429 → `RateLimited` (retryable).

### `coingecko_list_markets`
- **Input:** `vs_currency` defaults to `usd`. `order` accepts only `market_cap_asc/desc`, `volume_asc/desc`, and `id_asc/desc`, default `market_cap_desc`. Optional `ids` uses the price tool's normalized 500-raw/250-unique bounds; choose it or `category`, never both. Either selector supports `page` and `per_page` (default 50, max 250). Always request `price_change_percentage=1h,24h,7d`.
- **Output:** `coins: [{ id, symbol, name, currentPrice, marketCap, marketCapRank, totalVolume, high24h, low24h, priceChangePercentage24h, priceChangePercentage1h?, priceChangePercentage7d?, circulatingSupply?, totalSupply?, maxSupply?, ath, athDate, atl, atlDate }]`. Disclose cap via `ctx.enrich.truncated({ shown, cap: per_page })` and echo the resolved order/category via `ctx.enrich`.
- **ID selection.** Echo `appliedIds` and disclose `skippedIds`. A short first page lists any applied IDs with no market row in `notReturnedIds` in request order. Empty pages include navigation guidance.
- **Errors.** `conflicting_filters` rejects IDs combined with a nonempty category. A supplied ID list must yield at least one normalized ID. `unknown_category` applies on HTTP 404 for a category-filtered request.

### `coingecko_get_coin`
- **Input.** Normalized `id` and `vs_currency` (default `usd`). Select from `profile`, `market`, `platforms`, `links`, `developer`, `community`, and `sentiment`. Omit `sections` or pass an empty list for the full record. Currency validation applies when market data is selected.
- **Output:** section-selected `profile { description?, categories[], genesisDate?, hashingAlgorithm?, countryOrigin? }`, `market { currentPrice?, marketCap?, fullyDilutedValuation?, circulatingSupply?, totalSupply?, maxSupply?, ath?, atl?, priceChangePct { d24h?, d7d?, d30d?, d1y? } }`, `links { homepage[], whitepaper?, repos[], subreddit?, twitter?, telegram? }`, `developer { stars?, forks?, commits4w?, totalIssues?, closedIssues? }`, `community { redditSubscribers? }`, and `sentiment { upPercentage?, downPercentage? }`. Always include `id`, `symbol`, `name`, and attribution. Categories are display names, distinct from list_categories slugs. Market prices/cap/ATH/ATL select `vs_currency`; supply remains coin units. Sentiment comes from top-level vote percentages. CoinGecko no longer provides community Twitter follower counts.
- **Quote normalization:** select 24h/7d/30d/1y changes from their `*_in_currency[vs_currency]` maps, preserving zero and omitting null/missing metrics. Only USD may use a legacy scalar when the whole corresponding map is absent. The coin resource uses this same USD normalization. An own `current_price` key, including null, establishes support with no extra request. Only market-selected missing-key requests fetch `/simple/supported_vs_currencies`; supported missing quotes remain sparse, and a failed lookup stays an upstream error. No cache or unconditional catalog request.
- **Market and platform additions.** The market includes optional quote-currency `totalVolume`, `high24h`, and `low24h`, plus optional `marketCapRank`. `platforms` includes optional `assetPlatformId` and `contracts` with platform, contract address, and optional decimal precision. Merge both upstream platform maps by platform, preferring a nonblank detailed address and skipping blank placeholders. The coin resource includes the same full sections in USD.
- **Errors contract:** `coin_not_found` (NotFound) for an unrecognized slug; `unsupported_currency` (NotFound) only after the supported-currency catalog excludes the requested market currency. Shared transport contracts apply, including `retry_deadline_exceeded` (Timeout) when the complete coin-detail operation exceeds 50 seconds.
- **Note:** the full record is large (~tens of KB). `sections` is the primary trimming lever. If a single-section payload still overflows in practice, `outlineOnOverflow()` is the documented escalation (defer until measured).

### `coingecko_get_market_chart`
- **Input.** Omit `mode` to infer `range` from a complete Unix-second `from`/`to` pair without `days`. Other calls with omitted mode use `recent`, which requires `days=1..365|'max'`. Echo the selected mode and applied window in the result. A notice names any supplied window fields ignored by that mode. `interval=auto|daily|hourly` preserves auto defaults or forwards the explicit choice. `point_offset` defaults to 0, and `point_limit` defaults to 100 with an effective cap of 250.
- **Output:** exact indexed slices of `prices`, `marketCaps`, and `volumes` with every returned timestamp/value rendered in text. Per-series totals and `nextPointOffset` support continuation; each call refetches upstream, so live pages are not a snapshot. Cadence is measured before slicing: median positive spacing is `observedIntervalInMs`, classified within ±10% of five-minute/hourly/daily spacing; duplicate/nonmonotonic timestamps or other spacing are irregular, fewer than two points unknown. **Timestamps are milliseconds.**
- **Errors contract:** `coin_not_found` (NotFound) for upstream 404; `invalid_range` (ValidationError) for missing mode parameters or inverted ranges. Numeric days above 365 and invalid point offsets/limits fail input validation before fetching.

### `coingecko_get_trending`
- **Input:** none.
- **Output:** `coins: [{ id, name, symbol, marketCapRank?, priceUsd?, priceBtc?, priceChangePercentage24hUsd? }]`. Map from the nested `coins[].item.{...,data:{...}}` shape; pull USD out of the per-currency `price_change_percentage_24h` map. **Quirk (probe-confirmed):** trending's `data.market_cap`/`total_volume` are pre-formatted display strings (e.g. `"$92,219,216"`, `total_volume_btc` is also a string) — surface only the numeric `data.price` (float) and the USD slice of `data.price_change_percentage_24h` (dict keyed by currency code including `"usd"`) and drop or label-as-string the rest. Optionally include `nfts` count. Item-level fields available: `id, coin_id, name, symbol, market_cap_rank, thumb, small, large, slug, price_btc, score, data`.
- **Errors:** none domain-specific; 429 bubbles.

### `coingecko_get_global`
- **Input:** `vs_currency: z.string().default('usd')` (selects which key to read from the per-currency maps).
- **Output.** Required `totalMarketCap` in the selected currency and `dominance: [{ symbol, percentage }]` in upstream order. Include `fearGreedIndex: { value, sentiment }` when both fields are reported. Optional volume, BTC/ETH dominance, counts, 24h changes, and `updatedAtUnixSec` preserve reported zero and omit missing data. Both 24h changes use the upstream USD series. The global resource returns the same fields in USD.
- **Errors.** `unsupported_currency` applies when the requested market cap is unavailable.

### `coingecko_list_categories`
- **Catalog mode.** Fetch `/coins/categories/list`. Return category IDs and names in upstream order. Apply optional `name_contains` by requiring each normalized query token to match a word prefix in the name.
- **Market mode.** `include_market_data` selects `/coins/categories` and enables `order`, `min_market_cap`, `limit`, and `offset`. Use `market_cap_desc` by default and forward the order upstream. Filter by name and inclusive minimum USD market cap before slicing with a default limit of 50, a maximum of 250, and default offset 0. The endpoint can omit catalog categories.
- **Market output.** Category rows may also contain `marketCap`, `marketCapChange24hPct`, `volume24h`, `updatedAt`, and `topCoinIds`. Report the endpoint row count before filters as `totalCount` and supply `nextOffset` when matching rows remain. Each page refetches the live ranking.

## Design Decisions

1. **8 tools, goal-first, not an endpoint mirror.** CoinGecko exposes 40+ endpoints; the surface maps the 8 user goals from the brief. `/coins/list` (full dump) is dropped — `coingecko_search_coins` covers slug resolution better, and a 15k-row dump is not an agent workflow. `/exchanges` is dropped from v1 — exchange/ticker data serves a narrower audience than the price/market/research spine; defer until demand. The two richer historical endpoints collapse into one `coingecko_get_market_chart` with a `mode` enum (recent days vs. explicit Unix range) rather than two tools on the same noun.

2. **Known slugs can be passed directly.** ID-keyed tools point to `coingecko_search_coins` when callers have a name, ticker, or contract to resolve.

3. **`/simple/price` silent miss → explicit `missing` field + `all_missing` error.** Probe-confirmed: a wrong slug returns `200 {}` and a bad currency returns `{"coin":{}}` — no upstream error. Without handling, an agent reads a typo as "coin doesn't exist." `coingecko_get_prices` diffs requested ids against returned keys: partial misses populate `missing` (a normal result the agent can act on by re-resolving); a total miss throws the typed `all_missing` (NotFound) with recovery pointing at search. This is the server reporting what only it can know (which ids the upstream omitted), leaving the agent to decide intent.

4. **Upstream refusals retain their HTTP classification.** Shared contracts distinguish parameter, validation, authentication, permission, missing endpoint, request, conflict, timeout, rate-limit, and permanent HTTP failures. Promote only bounded plain-text explanations from `error` strings or direct/nested `status.error_message`; error code 10012 recommends the rolling 365-day window. Retry policy remains framework-owned, including permanent 501 and Retry-After. Expected 404s still become domain missing results, and `/simple/price`'s `200 {}` remains a successful silent miss.

5. **Category filtering runs locally.** Normalize case, accents, and punctuation, then require every query token to prefix a word. In market mode this keeps the upstream order and applies the name and market-cap filters before slicing.

6. **Exact pagination bounds analytical output.** Market tables cap pages at 250 rows; charts cap each exact series slice at 250 points. Charts preserve original observations and expose per-series totals and continuation instead of resampling. DataCanvas remains outside the tool surface because these retrieval paths support bounded inspection without adding another query tool.

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
- **IDs are slugs** (`bitcoin`). Use `/search` for names and tickers or `/coins/{platform}/contract/{address}` for token contracts. Discover supported quote currencies with `/simple/supported_vs_currencies`.
- **Pagination:** `/coins/markets` via `page` + `per_page` (≤250). `/simple/price` batches ≤250 ids, no pagination.
- **History:** keyless/Demo recent windows are at most 365 days. Upstream chooses auto cadence according to window and recency; explicit daily/hourly choices remain subject to upstream availability. The tool reports measured timestamp spacing rather than inferring it from the requested span.
- **`/global` fields.** The change percentages `market_cap_change_percentage_24h_usd` and `volume_change_percentage_24h_usd` use USD when reported. `total_market_cap` and `total_volume` map quote currencies to values. `market_cap_percentage` maps assets to shares of total market cap.
- **Error shapes:** `404 {"error":"..."}`, `429 {"status":{"error_code","error_message"}}`, and `200 {}`/`{"coin":{}}` silent miss on `/simple/price`.

Full probe-verified field listings: [`docs/api-probe-notes.md`](./api-probe-notes.md).
