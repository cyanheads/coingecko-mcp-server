/**
 * @fileoverview Server-specific configuration for the CoinGecko REST API.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * etc.) is handled by @cyanheads/mcp-ts-core.
 *
 * The server runs keyless by default — no env var is required. The single
 * optional variable, `COINGECKO_API_KEY`, attaches the Demo-tier header
 * (`x-cg-demo-api-key`) for a higher rate ceiling; the base URL is unchanged.
 *
 * `parseEnvConfig` reads an empty value and an unsubstituted `${…}` placeholder
 * (what an MCPB host forwards when the optional `user_config` field is left
 * blank) as unset, so a blank field never attaches a garbage API key header.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .optional()
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
