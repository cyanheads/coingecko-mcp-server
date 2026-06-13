/**
 * @fileoverview coingecko_get_trending — coins trending on CoinGecko in the last
 * 24 hours by search volume. Surfaces only trustworthy numerics (the upstream
 * payload mixes floats with pre-formatted display strings).
 * @module src/mcp-server/tools/definitions/get-trending.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const getTrendingTool = tool('coingecko_get_trending', {
  title: 'coingecko-mcp-server: get trending',
  description:
    'Coins trending on CoinGecko in the last 24 hours, by search volume — a heartbeat for "what\'s hot in crypto right now". No parameters. Returns trending coins with rank, USD price, and 24h change. (Upstream reports market cap and volume as pre-formatted display strings, not numbers, so those are omitted rather than presented as numeric data.)',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [...COINGECKO_SERVICE_ERRORS],

  input: z.object({}),

  output: z.object({
    coins: z
      .array(
        z
          .object({
            id: z.string().describe('CoinGecko slug — chain into other tools.'),
            name: z.string().describe('Display name.'),
            symbol: z.string().describe('Ticker symbol.'),
            marketCapRank: z
              .number()
              .optional()
              .describe('Global market-cap rank, when available.'),
            priceUsd: z.number().optional().describe('Current price in USD, when available.'),
            priceBtc: z.number().optional().describe('Current price in BTC, when available.'),
            priceChangePercentage24hUsd: z
              .number()
              .optional()
              .describe('24-hour USD price change percentage, when available.'),
          })
          .describe('A trending coin.'),
      )
      .describe(`Trending coins ranked by CoinGecko search volume. ${COINGECKO_ATTRIBUTION}.`),
    nftCount: z
      .number()
      .describe(
        'Number of trending NFTs upstream also reported (detail not surfaced by this tool).',
      ),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('coingecko_get_trending');
    const result = await getCoinGeckoService().trending(ctx);
    return {
      coins: result.coins,
      nftCount: result.nftCount,
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = ['## Trending (24h search volume)'];
    for (const c of result.coins) {
      const bits: string[] = [];
      if (c.marketCapRank != null) bits.push(`rank #${c.marketCapRank}`);
      if (c.priceUsd != null) bits.push(`$${c.priceUsd}`);
      if (c.priceBtc != null) bits.push(`${c.priceBtc} BTC`);
      if (c.priceChangePercentage24hUsd != null) bits.push(`24h ${c.priceChangePercentage24hUsd}%`);
      const suffix = bits.length ? ` — ${bits.join(' · ')}` : '';
      lines.push(`- **${c.name}** (${c.symbol}) \`${c.id}\`${suffix}`);
    }
    lines.push(`\n**Trending NFTs:** ${result.nftCount}`);
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
