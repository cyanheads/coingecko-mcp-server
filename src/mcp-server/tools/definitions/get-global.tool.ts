/**
 * @fileoverview coingecko_get_global — global crypto market snapshot: total market
 * cap and 24h volume, asset dominance, Fear & Greed, market counts, and 24h change.
 * @module src/mcp-server/tools/definitions/get-global.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const getGlobalTool = tool('coingecko_get_global', {
  title: 'coingecko-mcp-server: get global',
  description:
    'Global crypto market snapshot: total market cap and 24h volume in the selected currency, asset dominance, Fear & Greed index, active-coin and market counts, ongoing ICOs, and 24h market-cap and volume change when available.',
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
      .trim()
      .toLowerCase()
      .min(1)
      .default('usd')
      .describe(
        'Currency for total market cap and volume (e.g. "usd", "eur", "btc"). Defaults to "usd". Dominance and the change percentages are always USD-denominated upstream.',
      ),
  }),

  output: z.object({
    totalMarketCap: z.number().describe('Total crypto market capitalization in vs_currency.'),
    totalVolume24h: z.number().optional().describe('Total 24-hour trading volume in vs_currency.'),
    btcDominance: z
      .number()
      .optional()
      .describe('Bitcoin share of total market cap, as a percentage.'),
    ethDominance: z
      .number()
      .optional()
      .describe('Ethereum share of total market cap, as a percentage.'),
    dominance: z
      .array(
        z
          .object({
            symbol: z.string().describe('Asset symbol as provided by CoinGecko.'),
            percentage: z.number().describe('Share of total market cap, as a percentage.'),
          })
          .describe('One asset in the CoinGecko dominance map.'),
      )
      .describe('All entries in CoinGecko’s asset dominance map, in upstream order.'),
    fearGreedIndex: z
      .object({
        value: z.number().describe('Fear & Greed index value.'),
        sentiment: z.string().describe('Sentiment label as provided by CoinGecko.'),
      })
      .optional()
      .describe('Fear & Greed index when CoinGecko reports both the value and sentiment.'),
    activeCryptocurrencies: z
      .number()
      .optional()
      .describe('Count of active cryptocurrencies tracked.'),
    markets: z.number().optional().describe('Count of active markets (exchanges/pairs) tracked.'),
    ongoingIcos: z.number().optional().describe('Count of ongoing ICOs.'),
    marketCapChangePercentage24h: z
      .number()
      .optional()
      .describe('24-hour change in total market cap, as a percentage (always USD-denominated).'),
    volumeChangePercentage24h: z
      .number()
      .optional()
      .describe('24-hour change in total volume, as a percentage (always USD-denominated).'),
    updatedAtUnixSec: z
      .number()
      .optional()
      .describe('Snapshot time as a Unix timestamp in seconds.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_global', { vsCurrency: input.vs_currency });
    const g = await getCoinGeckoService().global(input.vs_currency, ctx);
    return { ...g, attribution: COINGECKO_ATTRIBUTION };
  },

  format: (result) => {
    const lines = ['## Global crypto market', `**Total market cap:** ${result.totalMarketCap}`];
    if (result.totalVolume24h !== undefined) lines.push(`**24h volume:** ${result.totalVolume24h}`);
    if (result.btcDominance !== undefined) lines.push(`**BTC dominance:** ${result.btcDominance}%`);
    if (result.ethDominance !== undefined) lines.push(`**ETH dominance:** ${result.ethDominance}%`);
    if (result.dominance.length > 0) {
      lines.push('**Asset dominance:**');
      for (const asset of result.dominance) {
        lines.push(`- ${escapeMarkdownInline(asset.symbol)}: ${asset.percentage}%`);
      }
    } else {
      lines.push('_No asset dominance data._');
    }
    if (result.fearGreedIndex)
      lines.push(
        `**Fear & Greed index:** ${result.fearGreedIndex.value} (${escapeMarkdownInline(result.fearGreedIndex.sentiment)})`,
      );
    if (result.marketCapChangePercentage24h !== undefined)
      lines.push(`**24h market-cap change:** ${result.marketCapChangePercentage24h}%`);
    if (result.volumeChangePercentage24h !== undefined)
      lines.push(`**24h volume change:** ${result.volumeChangePercentage24h}%`);
    if (result.activeCryptocurrencies !== undefined)
      lines.push(`**Active cryptocurrencies:** ${result.activeCryptocurrencies}`);
    if (result.markets !== undefined) lines.push(`**Markets:** ${result.markets}`);
    if (result.ongoingIcos !== undefined) lines.push(`**Ongoing ICOs:** ${result.ongoingIcos}`);
    if (result.updatedAtUnixSec !== undefined)
      lines.push(`**Updated at:** ${result.updatedAtUnixSec} (Unix seconds)`);
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
