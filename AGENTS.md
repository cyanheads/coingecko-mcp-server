# Developer Protocol

**Server:** coingecko-mcp-server
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const searchCoinsTool = tool('coingecko_search_coins', {
  title: 'coingecko-mcp-server: search coins',
  description:
    'Resolve a coin name or ticker symbol to a CoinGecko ID (slug). The required first step before any ID-keyed tool — CoinGecko keys data by slug (bitcoin, ethereum), not ticker (BTC, ETH).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).describe('Coin name or ticker symbol to resolve (e.g. "bitcoin", "ETH").'),
  }),
  output: z.object({
    coins: z.array(z.object({
      id: z.string().describe('CoinGecko slug — the id to chain into every other tool.'),
      symbol: z.string().describe('Ticker symbol (not unique across coins).'),
      name: z.string().describe('Display name.'),
    })).describe(`Ranked slug candidates. ${COINGECKO_ATTRIBUTION}.`),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('coingecko_search_coins', { query: input.query });
    const coins = await getCoinGeckoService().search(input.query, ctx);
    return { coins, attribution: COINGECKO_ATTRIBUTION };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => [{
    type: 'text',
    text: result.coins.map((c) => `**${c.name}** (${c.symbol}) — id: \`${c.id}\``).join('\n'),
  }],
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const coinResource = resource('coingecko://coin/{id}', {
  name: 'coingecko-mcp-server: coin record',
  description: 'Deep coin record by CoinGecko slug — same data as coingecko_get_coin.',
  mimeType: 'application/json',
  errors: [
    { reason: 'coin_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned 404 for the slug — it is not a recognized CoinGecko id.',
      recovery: 'Verify the slug with coingecko_search_coins — IDs are slugs (bitcoin), not tickers (BTC).' },
  ],
  params: z.object({ id: z.string().min(1).describe('CoinGecko slug (e.g. "bitcoin").') }),
  async handler(params, ctx) {
    const detail = await getCoinGeckoService().coinDetail(params.id, 'usd', ctx);
    if (!detail) throw ctx.fail('coin_not_found', `Coin "${params.id}" not found.`, {
      id: params.id, ...ctx.recoveryFor('coin_not_found'),
    });
    return { ...detail, attribution: COINGECKO_ATTRIBUTION };
  },
});
```

### Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const coinResearchPrompt = prompt('coingecko_coin_research', {
  title: 'coingecko-mcp-server: coin research',
  description:
    'Structures a full single-coin research pass — guides the agent through the search → get_coin → get_market_chart → get_global chain.',
  args: z.object({
    coin: z.string().min(1).describe('The coin to research — a name, ticker, or CoinGecko slug.'),
  }),
  generate: (args) => [
    {
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `Research the cryptocurrency: **${args.coin}**. Resolve its slug with coingecko_search_coins first, then pull its profile, sample recent price history, and frame it against the global market.`,
      },
    },
  ],
});
```

### Server config

This server runs keyless by default — the one optional var attaches the Demo-tier header. The `emptyAsUndefined` preprocess collapses unset, empty-string, and unsubstituted MCPB `${user_config.X}` placeholders to "no key" so a blank Claude Desktop field never sends a garbage header.

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  apiKey: z
    .preprocess(emptyAsUndefined, z.string().optional())
    .describe('Optional CoinGecko Demo API key (x-cg-demo-api-key header). Absent → keyless tier.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, { apiKey: 'COINGECKO_API_KEY' });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`COINGECKO_API_KEY`) not the path (`apiKey`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

Display identity is the machine name on every surface — `name` and `title` are both `coingecko-mcp-server`, never a Title Case form. `description` is not set here; it derives from `package.json` (the canonical source).

```ts
await createApp({
  name: 'coingecko-mcp-server',
  title: 'coingecko-mcp-server',               // display name = the machine name, always
  websiteUrl: 'https://github.com/cyanheads/coingecko-mcp-server',
  instructions:                                // session-level context, sent on every initialize
    'Cryptocurrency market data from CoinGecko. Data is keyed by slug (bitcoin), NOT ticker (BTC) — resolve names/tickers with coingecko_search_coins FIRST, then chain the id. Data refreshes ~every 60s. Runs keyless by default. Data provided by CoinGecko.',
  // ...tools, resources, prompts, setup()
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for cross-tool guidance (here: the slug-not-ticker rule and search-first workflow) instead of repeating the same context across every tool description. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

This is a stateless, read-only server — it uses `ctx.log`, `ctx.enrich`, `ctx.fail`/`ctx.recoveryFor`, and `ctx.signal`. It does not use `ctx.state`, `ctx.elicit`, or `ctx.progress`.

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.enrich` | Attach non-payload metadata to the response — `ctx.enrich.notice(msg)`, `ctx.enrich.truncated({ shown, cap })`, `ctx.enrich.total(n)`, or `ctx.enrich({ ...fields })`. Shapes match the tool's `enrichment` schema. Used here to disclose truncation, dropped ids/currencies, and applied filters. |
| `ctx.fail` / `ctx.recoveryFor` | Throw a typed contract error against the tool's `errors[]` reason union — `throw ctx.fail('coin_not_found', msg, { ...ctx.recoveryFor('coin_not_found') })`. |
| `ctx.signal` | `AbortSignal` for cancellation, forwarded to `fetchWithTimeout`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'coin_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Upstream returned 404 for the slug — it is not a recognized CoinGecko id.',
    recovery: 'Verify the slug with coingecko_search_coins — IDs are slugs (bitcoin), not tickers (BTC).' },
],
async handler(input, ctx) {
  const detail = await getCoinGeckoService().coinDetail(input.id, input.vs_currency, ctx);
  if (!detail) throw ctx.fail('coin_not_found', `Coin "${input.id}" not found.`, {
    id: input.id, ...ctx.recoveryFor('coin_not_found'),
  });
  return detail;
}
```

This server centralizes its service-level reasons (`rate_limited`, `upstream_unreachable`, `invalid_response`) in `src/services/coingecko/error-contracts.ts` and spreads `...COINGECKO_SERVICE_ERRORS` into each definition's `errors[]`, alongside the per-tool reasons declared inline. The shared service contract is the one sanctioned exception to "don't extract a shared `errors[]` constant" — those reasons are identical across every tool because they all call the same HTTP client.

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — registers the surface, inits the service
  config/
    server-config.ts                    # Optional COINGECKO_API_KEY (Zod schema)
  services/
    coingecko/
      api-client.ts                     # Low-level HTTP client — URL build, Demo-key header, error-envelope mapping
      coingecko-service.ts              # init/accessor service — one method per endpoint, withRetry + normalization
      error-contracts.ts                # Shared service reasons (rate_limited, upstream_unreachable, …) + recoveryFor
      types.ts                          # Raw upstream shapes + normalized domain types + COINGECKO_ATTRIBUTION
  mcp-server/
    tools/definitions/                  # 8 tools: search-coins, get-prices, list-categories, list-markets,
                                        #          get-coin, get-market-chart, get-trending, get-global
    resources/definitions/              # 2 resources: coin (coingecko://coin/{id}), global (coingecko://global)
    prompts/definitions/                # 1 prompt: coin-research (coingecko_coin_research)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `techniques` | Catalog of reusable response/data-shaping patterns (overflow handling, payload shaping, retrieval) |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService — stand up a self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5). Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `npm run tree` | Generate directory structure doc |
| `npm run list-skills` | List the project's available skills and their paths |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm run lint:mcp` | Validate MCP tool/resource/prompt definitions against the spec |
| `npm run lint:packaging` | Verify `manifest.json` ↔ `server.json` env var consistency (run by devcheck) |
| `npm test` | Run tests |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `npm run release:github` | Create the GitHub Release from the annotated tag (used by release-and-publish) |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; `ctx.enrich` for non-payload metadata (truncation, dropped ids/currencies, applied filters)
- [ ] Handlers throw on failure — `ctx.fail` against the tool's `errors[]` contract, factories, or plain `Error`; no try/catch
- [ ] Every tool/resource/prompt output carries `COINGECKO_ATTRIBUTION` ("Data provided by CoinGecko") — required by CoinGecko's ToS
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
