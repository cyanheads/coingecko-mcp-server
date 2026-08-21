<div align="center">
  <h1>@cyanheads/coingecko-mcp-server</h1>
  <p><b>Market data for 15,000+ cryptocurrencies — prices, history, trends, and deep coin metadata via CoinGecko.</b>
  <div>8 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/coingecko-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fcoingecko-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/coingecko-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/coingecko-mcp-server/releases/latest/download/coingecko-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=coingecko-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY29pbmdlY2tvLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22coingecko-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcoingecko-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Keyless by default · runs locally.** No API key required — an optional CoinGecko Demo key raises the rate ceiling. Runs as a local stdio/HTTP server; there is no public hosted instance, since CoinGecko's terms do not permit redistributing their data. Data provided by [CoinGecko](https://www.coingecko.com/).

</div>

---

## Tools

Eight tools covering the crypto market-data spine — slug resolution first, then prices, ranked markets, deep coin profiles, historical series, trending, and global macro stats. CoinGecko keys all data by **slug** (`bitcoin`, `ethereum`), not ticker (`BTC`, `ETH`), so `coingecko_search_coins` is the entry point that feeds every ID-keyed tool.

| Tool | Description |
|:---|:---|
| `coingecko_search_coins` | Resolve a coin name or ticker symbol to a CoinGecko ID (slug). The required first step before any ID-keyed tool. |
| `coingecko_get_prices` | Current price and core market stats for one or more coins in one or more currencies. Batch up to 250 slugs; reports unresolved ids in a `missing` field. |
| `coingecko_list_markets` | Ranked market table — top coins by market cap, volume, or 24h change, optionally filtered to a category. |
| `coingecko_get_coin` | Deep single-coin profile — description, links, market data, developer activity, community, sentiment. `sections` trims the large record. |
| `coingecko_get_market_chart` | Historical price, market cap, and volume series. `recent` (last N days, auto-granularity) or `range` (explicit Unix-second window) mode. |
| `coingecko_get_trending` | Coins trending on CoinGecko in the last 24 hours, by search volume. |
| `coingecko_get_global` | Global crypto market snapshot — total market cap and volume, BTC/ETH dominance, active counts, ongoing ICOs, 24h change. |
| `coingecko_list_categories` | Coin categories (`category_id` + display name) — the valid slugs for `coingecko_list_markets`'s `category` filter. |

### `coingecko_search_coins`

Resolve a name or ticker to the CoinGecko slug every other tool keys on.

- Tickers are not unique (many coins share `ETH`/`USDC`) — returns ranked candidates with `id`, `symbol`, `name`, and `market_cap_rank` to disambiguate
- Returns the top 25 matches by relevance; discloses truncation when the list is capped
- An empty result is a normal outcome (not an error), with guidance to broaden the query

---

### `coingecko_get_prices`

Current price and core market stats (market cap, 24h volume, 24h change) for a batch of coins in a batch of currencies.

- Batch-friendly — pass a whole portfolio of up to 250 slugs in one call
- One row per `(id, currency)` that returned a price
- A wrong/unknown slug returns an empty `200` upstream rather than an error; this tool diffs requested-vs-returned ids and lists the gaps in a `missing` field, so a typo reads as "unresolved", not "nonexistent"
- Unsupported currency codes are silently dropped upstream and surfaced as a notice
- Throws `all_missing` only when **no** requested id resolved

---

### `coingecko_list_markets`

The entry point for "top 20 DeFi coins" or "biggest gainers today".

- Sort by market cap, volume, or 24h price change (ascending or descending)
- Optional category filter — pass a `category_id` from `coingecko_list_categories`
- Pagination via `page` and `per_page` (up to 250 rows); discloses when a page is full
- Per-coin market fields: price, cap, volume, 1h/24h/7d change, supply, ATH/ATL
- Detects an unrecognized category (CoinGecko returns empty rather than erroring) and maps it to `unknown_category`

---

### `coingecko_get_coin`

The full picture for "tell me everything about Ethereum".

- Six sections — `profile`, `market`, `links`, `developer`, `community`, `sentiment`; pass `sections` to fetch only what you need (the full record is large)
- Market figures denominated in a chosen `vs_currency`
- `categories` here are display names (e.g. `"Layer 1 (L1)"`), distinct from the `category_id` slugs returned by `coingecko_list_categories`
- Upstream is sparse — absent fields are omitted rather than fabricated

---

### `coingecko_get_market_chart`

Historical series for trend and charting questions (use `coingecko_get_prices` for the current snapshot).

- `recent` mode: last N days, with granularity auto-scaling by span (≤1 day → ~5-min, 2–90 → hourly, >90 → daily); pass `days` (or `"max"`)
- `range` mode: an explicit window via `from`/`to` as Unix **seconds**
- Returns timestamped point arrays for price, market cap, and volume
- Chart timestamps are Unix **milliseconds** (note: `coingecko_get_prices` last-updated is in seconds)

---

### `coingecko_get_trending`

A heartbeat for "what's hot in crypto right now". No parameters.

- Coins trending by 24-hour search volume, with rank, USD price, and 24h USD change
- Upstream reports market cap and volume as pre-formatted display strings, not numbers — those are omitted rather than presented as numeric data

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `coingecko://coin/{id}` | Deep coin record by slug — same data as `coingecko_get_coin` (full record, USD market figures). |
| Resource | `coingecko://global` | Global crypto market snapshot — same data as `coingecko_get_global`. |
| Prompt | `coingecko_coin_research` | Guides a full single-coin research pass through the search → get_coin → get_market_chart → get_global chain. |

All resource data is also reachable via tools — the resources mirror `coingecko_get_coin` and `coingecko_get_global` exactly, so tool-only clients lose nothing. Large collections (markets, categories) are not exposed as resources; use `coingecko_list_markets` and `coingecko_list_categories` instead.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

CoinGecko-specific:

- Type-safe client for the CoinGecko v3 REST API, with one service method per endpoint
- Runs keyless on the public tier; an optional Demo API key (`x-cg-demo-api-key`) raises the rate ceiling with no other config change
- Calibrated retry/backoff on the rate-limited public tier — 429s, 5xx, and timeouts retry; `Retry-After` is honored
- Three distinct upstream error shapes mapped to typed reasons (404 → `coin_not_found`, 429 → `rate_limited`, the `/simple/price` silent miss handled as a `missing` field, not an error)

Agent-friendly output:

- Search-before-query enforced through descriptions — every ID-keyed tool states slugs-not-tickers and points back to `coingecko_search_coins`
- Provenance and graceful degradation — `coingecko_get_prices` reports unresolved ids and dropped currencies instead of failing; truncation and applied filters are disclosed via enrichment
- Units made explicit — timestamp fields document seconds vs. milliseconds so callers don't misread them
- Required CoinGecko attribution carried on every tool, resource, and prompt output

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

Refer to "your MCP client configuration file" generically — different clients use different config paths and this server isn't client-specific.

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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
| `COINGECKO_API_KEY` | Optional CoinGecko **Demo** API key. When set, it is sent as the `x-cg-demo-api-key` header for the dedicated Demo tier (10k/mo, 100 req/min); the base URL is unchanged. Absent → keyless public tier (shared, IP-throttled). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
