/**
 * @fileoverview coingecko_get_global — global crypto market snapshot: total market
 * cap and 24h volume, BTC/ETH dominance, active-coin/market counts, ongoing ICOs,
 * and 24h change. One call for the macro picture; no coin id needed.
 * @module src/mcp-server/tools/definitions/get-global.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const getGlobalTool = tool('coingecko_get_global', {
  title: 'coingecko-mcp-server: get global',
  description:
    'Global crypto market snapshot: total market cap and 24h volume (in a chosen currency), BTC/ETH dominance, active-coin and active-market counts, ongoing ICOs, and 24h market-cap and volume change. One call for the macro picture — no coin id needed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unsupported_currency',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested vs_currency is absent from the /global per-currency maps — /global has no upstream vs_currency validation, so an unknown code returns no totals.',
      recovery: 'Use a supported currency code (e.g. "usd", "eur", "btc").',
      thrownBy: 'service',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    vs_currency: z
      .string()
      .min(1)
      .default('usd')
      .describe(
        'Currency for total market cap and volume (e.g. "usd", "eur", "btc"). Defaults to "usd". Dominance and the change percentages are always USD-denominated upstream.',
      ),
  }),

  output: z.object({
    totalMarketCap: z.number().describe('Total crypto market capitalization in vs_currency.'),
    totalVolume24h: z.number().describe('Total 24-hour trading volume in vs_currency.'),
    btcDominance: z.number().describe('Bitcoin share of total market cap, as a percentage.'),
    ethDominance: z.number().describe('Ethereum share of total market cap, as a percentage.'),
    activeCryptocurrencies: z.number().describe('Count of active cryptocurrencies tracked.'),
    markets: z.number().describe('Count of active markets (exchanges/pairs) tracked.'),
    ongoingIcos: z.number().describe('Count of ongoing ICOs.'),
    marketCapChangePercentage24h: z
      .number()
      .describe('24-hour change in total market cap, as a percentage (always USD-denominated).'),
    volumeChangePercentage24h: z
      .number()
      .describe('24-hour change in total volume, as a percentage (always USD-denominated).'),
    updatedAtUnixSec: z.number().describe('Snapshot time as a Unix timestamp in seconds.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_global', { vsCurrency: input.vs_currency });
    const g = await getCoinGeckoService().global(input.vs_currency, ctx);
    return { ...g, attribution: COINGECKO_ATTRIBUTION };
  },

  format: (result) => {
    const lines = [
      '## Global crypto market',
      `**Total market cap:** ${result.totalMarketCap}`,
      `**24h volume:** ${result.totalVolume24h}`,
      `**BTC dominance:** ${result.btcDominance.toFixed(2)}% | **ETH dominance:** ${result.ethDominance.toFixed(2)}%`,
      `**24h market-cap change:** ${result.marketCapChangePercentage24h.toFixed(2)}% | **24h volume change:** ${result.volumeChangePercentage24h.toFixed(2)}%`,
      `**Active cryptocurrencies:** ${result.activeCryptocurrencies} | **Markets:** ${result.markets} | **Ongoing ICOs:** ${result.ongoingIcos}`,
      `**Updated at:** ${result.updatedAtUnixSec} (Unix seconds)`,
      `\n_${result.attribution}_`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
