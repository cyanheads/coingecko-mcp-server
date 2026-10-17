<div align="center">
  <h1>@cyanheads/coingecko-mcp-server</h1>
  <p><b>Market data for 15,000+ cryptocurrencies — prices, history, trends, and deep coin metadata via CoinGecko.</b>
  <div>8 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/coingecko-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fcoingecko-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/coingecko-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/coingecko-mcp-server/releases/latest/download/coingecko-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=coingecko-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY29pbmdlY2tvLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22coingecko-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcoingecko-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Cryptocurrency market data from CoinGecko — prices, rankings, historical charts, and deep coin profiles across 15,000+ coins. Resolve a name or ticker to CoinGecko's slug-keyed ID, then chain into price lookups, ranked markets, and trend charts.

### Tools

| Tool | Description |
|:---|:---|
| `coingecko_search_coins` | Resolve a coin name or ticker symbol to a CoinGecko ID (slug). The required first step before any ID-keyed tool. |
| `coingecko_get_prices` | Current prices and core market stats across coin/currency batches. |
| `coingecko_list_markets` | Ranked market table — coins by market cap, volume, or ID, optionally filtered to a category or selected IDs. |
| `coingecko_get_coin` | Deep single-coin profile — description, links, market data, developer activity, community, sentiment. `sections` trims the large record. |
| `coingecko_get_market_chart` | Historical price, market cap, and volume series. `recent` (last N days, auto-granularity) or `range` (explicit Unix-second window) mode. |
| `coingecko_get_trending` | Coins trending on CoinGecko in the last 24 hours, by search volume. |
| `coingecko_get_global` | Global crypto market snapshot — total market cap and volume, BTC/ETH dominance, active counts, ongoing ICOs, 24h change. |
| `coingecko_list_categories` | Coin categories (`category_id` + display name) — the valid slugs for `coingecko_list_markets`'s `category` filter. |

### Resources

| Resource | Description |
|:---|:---|
| `coingecko://coin/{id}` | Deep coin record by slug — same data as `coingecko_get_coin` (full record, USD market figures). |
| `coingecko://global` | Global crypto market snapshot — same data as `coingecko_get_global`. |

All resource data is also reachable via tools — the resources mirror `coingecko_get_coin` and `coingecko_get_global` exactly, so tool-only clients lose nothing. Large collections (markets, categories) are not exposed as resources; use `coingecko_list_markets` and `coingecko_list_categories` instead.

### Prompts

| Prompt | Description |
|:---|:---|
| `coingecko_coin_research` | Guides a full single-coin research pass through the search → get_coin → get_market_chart → get_global chain. |

## Capability reference

### `coingecko_search_coins` <sub>tool</sub>

- Tickers are not unique (many coins share `ETH`/`USDC`) — returns ranked candidates with `id`, `symbol`, `name`, and `marketCapRank` to disambiguate
- Returns the top 25 matches by relevance; `enrichment.truncated` plus `shown`/`cap` disclose when the list is capped
- An empty result is a normal outcome, not an error — `enrichment.notice` suggests broadening the query

---

### `coingecko_get_prices` <sub>tool</sub>

- Accepts up to 500 raw IDs (trimmed, lowercased, deduplicated) and processes the first 250 unique slugs; `skippedIds` lists the rest and `missing` lists ids that didn't resolve, since an unknown slug returns an empty upstream response rather than an error
- One row per `(id, currency)` that returned a price; market cap, 24h volume, and 24h change are optional per row. Currencies with no quotes are noted in `enrichment.notice`
- `lastUpdatedAtUnixSec` is Unix seconds — `coingecko_get_market_chart`'s point timestamps are milliseconds
- Throws `all_missing` when no requested id resolves, `no_price_data` when IDs resolve but no requested currency returns a numeric quote

---

### `coingecko_list_markets` <sub>tool</sub>

- Sort by market cap, volume, or ID, ascending or descending, via `order`; paginate with `page` and `per_page` (default 50, max 250 rows)
- Filter by `ids` (same 500-raw/250-unique bounds as price batches; `appliedIds` and `skippedIds` show the selection) or by `category` (a `categoryId` from `coingecko_list_categories`), not both — combining them returns `conflicting_filters`
- Per-coin fields include price, cap, volume, 1h/24h/7d change, supply, and ATH/ATL; `enrichment.truncated` flags a full page
- Throws `unknown_category` when CoinGecko returns HTTP 404 for a category-filtered request

---

### `coingecko_get_coin` <sub>tool</sub>

- Six sections — `profile`, `market`, `links`, `developer`, `community`, `sentiment`; `sections` trims the response to just what's needed (the full record is large)
- Prices and percentage-change windows use `vs_currency` (defaults to `usd`); missing upstream fields are omitted rather than fabricated
- `profile.categories` are display names (e.g. `"Layer 1 (L1)"`), distinct from the `categoryId` slugs `coingecko_list_categories` returns
- Throws `coin_not_found` when the slug isn't recognized upstream, `unsupported_currency` when the requested market currency isn't a supported one

---

### `coingecko_get_market_chart` <sub>tool</sub>

- `recent` mode takes 1–365 days (`"max"` aliases the 365-day window and emits a notice); `range` mode takes `from`/`to` as Unix seconds
- `interval` selects `auto` (upstream default), `daily`, or `hourly`, subject to upstream tier/window availability
- Pages with `point_offset` (default 0) and `point_limit` (default 100, cap 250); per-series totals and `nextPointOffset` support continuation, and each page refetches upstream data
- `granularity` reports the series spacing as `5-minute`, `hourly`, `daily`, `irregular`, or `unknown`; point timestamps are Unix milliseconds, while `coingecko_get_prices`'s `lastUpdatedAtUnixSec` is seconds
- Throws `invalid_range` on a mode/parameter mismatch, `coin_not_found` when the slug isn't recognized

---

### `coingecko_get_trending` <sub>tool</sub>

- No parameters — 24-hour trending coins by search volume, each with `marketCapRank`, `priceUsd`, `priceBtc`, and `priceChangePercentage24hUsd` when available
- Upstream reports market cap and volume as pre-formatted display strings, not numbers — those fields are omitted rather than presented as numeric data
- `nftCount` reports the trending-NFT count upstream also returns; NFT detail itself isn't surfaced

---

### `coingecko_get_global` <sub>tool</sub>

- No coin id needed — one call for the macro snapshot
- `vs_currency` (default `usd`) scopes only total market cap and volume; dominance and the 24h change percentages are always USD-denominated upstream
- Throws `unsupported_currency` when the requested currency has no entry in upstream's per-currency maps — `/global` has no upstream currency validation, so an unknown code silently returns no totals
- Returns active-cryptocurrency and active-market counts, ongoing ICO count, and a Unix-second snapshot timestamp

---

### `coingecko_list_categories` <sub>tool</sub>

- Optional `name_contains` filters by whitespace-separated tokens, case- and punctuation-insensitive; every token must appear in the name
- `enrichment.totalCount` reports the full category count before filtering; a filter that matches nothing returns `enrichment.notice`
- Returned `categoryId` values are what `coingecko_list_markets`'s `category` param expects

---

### `coingecko://coin/{id}` <sub>resource</sub>

- Same data as `coingecko_get_coin`'s full record, always denominated in USD
- `{id}` is a CoinGecko slug (e.g. `"bitcoin"`) — resolve tickers with `coingecko_search_coins`
- Throws `coin_not_found` when the slug isn't recognized upstream

---

### `coingecko://global` <sub>resource</sub>

- Same data as `coingecko_get_global`, always denominated in USD
- No parameters

---

### `coingecko_coin_research` <sub>prompt</sub>

- Argument: `coin` required — a name, ticker, or CoinGecko slug
- Returns an assistant framing message plus a user message that walks the search → get_coin → get_market_chart → get_global chain

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CoinGecko-specific:

- Type-safe client for the CoinGecko v3 REST API, with one service method per endpoint
- Runs keyless on the public tier; an optional Demo API key (`x-cg-demo-api-key`) raises the rate ceiling with no other config change
- Retry/backoff for rate limits, transient upstream failures, and timeouts; honors `Retry-After`, and permanent refusals fail immediately
- Status-specific error reasons with recovery hints, including narrowing the range on historical-window restrictions

Agent-friendly output:

- Search-before-query enforced through descriptions — every ID-keyed tool states slugs-not-tickers and points back to `coingecko_search_coins`
- Partial reads — price results disclose unresolved IDs and currencies without quotes; enrichment discloses caps and applied filters
- Units made explicit — timestamp fields document seconds vs. milliseconds
- Required CoinGecko attribution ships on every tool and resource output; the research prompt instructs the agent to attribute its findings the same way

## Getting started

Add the following to your MCP client configuration file. No API key is required — set `COINGECKO_API_KEY` only to attach the higher CoinGecko Demo tier (see [Configuration](#configuration)).

```json
{
  "mcpServers": {
    "coingecko-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/coingecko-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "coingecko-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/coingecko-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "coingecko-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/coingecko-mcp-server:latest"
      ]
    }
  }
}
```

To attach a CoinGecko Demo key, add `"COINGECKO_API_KEY": "your-demo-key"` to the `env` block (or `-e COINGECKO_API_KEY=your-demo-key` for Docker).

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No account or API key required to run. Optionally, a free [CoinGecko Demo API key](https://www.coingecko.com/en/api/pricing) for a higher rate ceiling (10k calls/month, 100 req/min) over the shared keyless public pool.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/coingecko-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd coingecko-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# the server runs with no .env at all; edit only to set COINGECKO_API_KEY
```

## Configuration

The server runs with zero configuration. The one server-specific variable is optional:

| Variable | Description | Default |
|:---|:---|:---|
| `COINGECKO_API_KEY` | Optional CoinGecko **Demo** API key, sent as the `x-cg-demo-api-key` header (10k/mo, 100 req/min). Absent → keyless public tier. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

**Rate limits and freshness.** The keyless public tier shares an IP-throttled pool, so bursty multi-tool workflows can hit `429`s under light load; the server backs off and retries, but cannot raise the ceiling — a free Demo key does. CoinGecko data refreshes roughly every 60 seconds and is not tick-level.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t coingecko-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 coingecko-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/coingecko-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits the CoinGecko service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services/coingecko` | CoinGecko v3 REST API service — HTTP client, retry/error mapping, response normalization, domain types. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
