# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-09-21

mcp-ts-core 0.13.6 adoption: HTTP now serves stateless by default (#3), unless MCP_SESSION_MODE overrides it; plugin manifests no longer clobber a user's COINGECKO_API_KEY.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-08-21

mcp-ts-core ^0.10.6 → ^0.12.3 (MCP SDK v2): protocol 2026-07-28 served alongside the 2025 era, strict tool inputs, error envelope declared in outputSchema, Retry-After honored; unsupported_currency/unknown_category → NotFound and invalid_range → ValidationError; Docker build stage pinned to \$BUILDPLATFORM for native multi-arch builds.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Scope the README header to the published npm name and add the repository field to manifest.json.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release — 8 cryptocurrency market-data tools, 2 resources, and a research prompt over the CoinGecko v3 REST API (keyless by default).
