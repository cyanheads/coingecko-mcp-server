/**
 * @fileoverview coingecko_list_markets — ranked market table (top coins by market
 * cap, volume, or 24h change, optionally filtered to a category).
 * @module src/mcp-server/tools/definitions/list-markets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const listMarketsTool = tool('coingecko_list_markets', {
  title: 'coingecko-mcp-server: list markets',
  description:
    'Ranked market table — top coins sorted by market cap, volume, or 24h price change, optionally filtered to a category. The entry point for "top 20 DeFi coins" or "biggest gainers today". Returns standard market fields per coin (price, cap, volume, supply, 24h/1h/7d change, ATH/ATL). Discover valid category slugs with coingecko_list_categories and pass the category_id exactly.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_category',
      code: JsonRpcErrorCode.NotFound,
      when: 'A category was supplied but the result was empty — the slug is not recognized upstream (CoinGecko returns empty rather than erroring on a bad category).',
      recovery: 'List valid slugs with coingecko_list_categories and pass the category_id exactly.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    vs_currency: z
      .string()
      .min(1)
      .default('usd')
      .describe('Currency to denominate the table in (e.g. "usd", "eur", "btc"). Single currency.'),
    order: z
      .enum([
        'market_cap_desc',
        'market_cap_asc',
        'volume_desc',
        'volume_asc',
        'price_change_percentage_24h_desc',
        'price_change_percentage_24h_asc',
      ])
      .default('market_cap_desc')
      .describe(
        'Sort order. Use price_change_percentage_24h_desc for top gainers, _asc for top losers.',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Restrict to a category slug from coingecko_list_categories (e.g. "layer-1", "decentralized-finance-defi"). Omit for all coins.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('1-based page number for paging beyond per_page rows.'),
    per_page: z.number().int().min(1).max(250).default(50).describe('Rows per page (max 250).'),
  }),

  output: z.object({
    coins: z
      .array(
        z
          .object({
            id: z.string().describe('CoinGecko slug.'),
            symbol: z.string().describe('Ticker symbol.'),
            name: z.string().describe('Display name.'),
            currentPrice: z
              .number()
              .optional()
              .describe('Current price in vs_currency, when available.'),
            marketCap: z
              .number()
              .optional()
              .describe('Market capitalization in vs_currency, when available.'),
            marketCapRank: z
              .number()
              .optional()
              .describe('Global market-cap rank, when available.'),
            totalVolume: z
              .number()
              .optional()
              .describe('24-hour trading volume in vs_currency, when available.'),
            high24h: z
              .number()
              .optional()
              .describe('24-hour high price in vs_currency, when available.'),
            low24h: z
              .number()
              .optional()
              .describe('24-hour low price in vs_currency, when available.'),
            priceChangePercentage24h: z
              .number()
              .optional()
              .describe('24-hour price change percentage, when available.'),
            priceChangePercentage1h: z
              .number()
              .optional()
              .describe('1-hour price change percentage, when available.'),
            priceChangePercentage7d: z
              .number()
              .optional()
              .describe('7-day price change percentage, when available.'),
            circulatingSupply: z
              .number()
              .optional()
              .describe('Circulating supply (coin units), when available.'),
            totalSupply: z
              .number()
              .optional()
              .describe('Total supply (coin units), when available.'),
            maxSupply: z
              .number()
              .optional()
              .describe('Maximum supply (coin units), when available.'),
            ath: z
              .number()
              .optional()
              .describe('All-time-high price in vs_currency, when available.'),
            athDate: z
              .string()
              .optional()
              .describe('All-time-high date (ISO 8601), when available.'),
            atl: z
              .number()
              .optional()
              .describe('All-time-low price in vs_currency, when available.'),
            atlDate: z
              .string()
              .optional()
              .describe('All-time-low date (ISO 8601), when available.'),
          })
          .describe('A ranked market row.'),
      )
      .describe(`Ranked market rows for this page. ${COINGECKO_ATTRIBUTION}.`),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the page filled to per_page (more rows likely on the next page). Present only when the page is full.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Rows returned on this page. Present only when the page is full.'),
    cap: z
      .number()
      .optional()
      .describe('The per_page cap applied. Present only when the page is full.'),
    appliedOrder: z.string().describe('Sort order applied.'),
    appliedCategory: z.string().optional().describe('Category slug applied, when filtered.'),
  },

  async handler(input, ctx) {
    ctx.log.info('coingecko_list_markets', {
      vsCurrency: input.vs_currency,
      order: input.order,
      category: input.category,
      page: input.page,
      perPage: input.per_page,
    });

    const coins = await getCoinGeckoService().coinsMarkets(
      {
        vsCurrency: input.vs_currency,
        order: input.order,
        ...(input.category && { category: input.category }),
        page: input.page,
        perPage: input.per_page,
      },
      ctx,
    );

    // null = upstream 404 on a category-filtered request → unrecognized slug.
    // (A valid category paged past its last row returns an empty array, not 404,
    // so it is a normal empty result here — not unknown_category.)
    if (coins === null) {
      throw ctx.fail('unknown_category', `Category "${input.category}" is not recognized.`, {
        ...(input.category && { category: input.category }),
        ...ctx.recoveryFor('unknown_category'),
      });
    }

    ctx.enrich({
      appliedOrder: input.order,
      ...(input.category && { appliedCategory: input.category }),
    });
    if (coins.length >= input.per_page) {
      ctx.enrich.truncated({ shown: coins.length, cap: input.per_page });
    }

    return { coins, attribution: COINGECKO_ATTRIBUTION };
  },

  format: (result) => {
    if (result.coins.length === 0) {
      return [{ type: 'text', text: `_No coins._\n\n_${result.attribution}_` }];
    }
    const lines = ['## Markets'];
    for (const c of result.coins) {
      const rank = c.marketCapRank != null ? `#${c.marketCapRank} ` : '';
      const price = c.currentPrice != null ? ` — ${c.currentPrice}` : '';
      lines.push(`### ${rank}${c.name} (${c.symbol})${price}`);
      lines.push(`id: \`${c.id}\``);
      const stats: string[] = [];
      if (c.marketCap != null) stats.push(`cap ${c.marketCap}`);
      if (c.totalVolume != null) stats.push(`vol24h ${c.totalVolume}`);
      if (c.priceChangePercentage1h != null) stats.push(`1h ${c.priceChangePercentage1h}%`);
      if (c.priceChangePercentage24h != null) stats.push(`24h ${c.priceChangePercentage24h}%`);
      if (c.priceChangePercentage7d != null) stats.push(`7d ${c.priceChangePercentage7d}%`);
      if (stats.length) lines.push(stats.join(' · '));
      const range: string[] = [];
      if (c.high24h != null) range.push(`high24h ${c.high24h}`);
      if (c.low24h != null) range.push(`low24h ${c.low24h}`);
      if (c.ath != null) range.push(`ATH ${c.ath}${c.athDate ? ` (${c.athDate})` : ''}`);
      if (c.atl != null) range.push(`ATL ${c.atl}${c.atlDate ? ` (${c.atlDate})` : ''}`);
      if (range.length) lines.push(range.join(' · '));
      const supply: string[] = [];
      if (c.circulatingSupply != null) supply.push(`circ ${c.circulatingSupply}`);
      if (c.totalSupply != null) supply.push(`total ${c.totalSupply}`);
      if (c.maxSupply != null) supply.push(`max ${c.maxSupply}`);
      if (supply.length) lines.push(`supply: ${supply.join(' · ')}`);
    }
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
