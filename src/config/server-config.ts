/**
 * @fileoverview Server-specific configuration for the CoinGecko REST API.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * etc.) is handled by @cyanheads/mcp-ts-core.
 *
 * The server runs keyless by default — no env var is required. The single
 * optional variable, `COINGECKO_API_KEY`, attaches the Demo-tier header
 * (`x-cg-demo-api-key`) for a higher rate ceiling; the base URL is unchanged.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Treats an unset env var (`undefined`), a set-but-empty env var (`""`), and an
 * unsubstituted MCPB placeholder (`${user_config.X}`) identically as "no key".
 * The placeholder case occurs when a Claude Desktop / MCPB host installs the
 * bundle and the user leaves the optional `user_config` field blank — the
 * literal `${user_config.X}` string is passed through to the process instead of
 * being substituted, so without this guard a blank field would attach a garbage
 * API key header.
 */
const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  apiKey: z
    .preprocess(emptyAsUndefined, z.string().optional())
    .describe(
      'Optional CoinGecko Demo API key. Present → sent as the x-cg-demo-api-key header for the dedicated Demo tier (10k/mo, 100 rpm). Absent → keyless public tier.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'COINGECKO_API_KEY',
  });
  return _config;
}
