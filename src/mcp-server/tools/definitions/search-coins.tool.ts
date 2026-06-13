/**
 * @fileoverview coingecko_search_coins — resolve a coin name or ticker symbol to
 * a CoinGecko ID (slug). The required first step before any ID-keyed tool.
 * @module src/mcp-server/tools/definitions/search-coins.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

/** Top slice returned — search yields many low-relevance tails. */
const MAX_COINS = 25;

export const searchCoinsTool = tool('coingecko_search_coins', {
  title: 'coingecko-mcp-server: search coins',
  description:
    'Resolve a coin name or ticker symbol to a CoinGecko ID (slug). The required first step before any ID-keyed tool — CoinGecko keys data by slug (bitcoin, ethereum), not ticker (BTC, ETH), and tickers are not unique (many coins share ETH/USDC). Returns ranked matches with id, symbol, name, and market_cap_rank to disambiguate; pick the intended coin from the ranked candidates.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [...COINGECKO_SERVICE_ERRORS],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Coin name or ticker symbol to resolve (e.g. "bitcoin", "ETH", "solana").'),
  }),

  output: z.object({
    coins: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'CoinGecko slug — the id to chain into every other tool (e.g. "ethereum").',
              ),
            symbol: z.string().describe('Ticker symbol (not unique across coins; e.g. "eth").'),
            name: z.string().describe('Display name (e.g. "Ethereum").'),
            marketCapRank: z
              .number()
              .optional()
              .describe(
                'Market-cap rank when known — lower is larger; aids disambiguation. Omitted when unranked.',
              ),
            thumb: z.string().optional().describe('Thumbnail icon URL when provided by upstream.'),
          })
          .describe('A ranked slug candidate.'),
      )
      .describe(
        `Ranked slug candidates (top ${MAX_COINS} by relevance). ${COINGECKO_ATTRIBUTION}.`,
      ),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the candidate list was capped at the limit. Present only when capped.'),
    shown: z
      .number()
      .optional()
      .describe('Number of candidates returned. Present only when capped.'),
    cap: z
      .number()
      .optional()
      .describe('The cap applied to the candidate list. Present only when capped.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched — echoes the query and suggests how to broaden.'),
  },

  async handler(input, ctx) {
    ctx.log.info('coingecko_search_coins', { query: input.query });
    const all = await getCoinGeckoService().search(input.query, ctx);
    const coins = all.slice(0, MAX_COINS);

    if (coins.length === 0) {
      ctx.enrich.notice(
        `No coin matched "${input.query}". Try a fuller name (e.g. "bitcoin" instead of a partial) or the ticker symbol.`,
      );
    } else if (all.length > MAX_COINS) {
      ctx.enrich.truncated({ shown: coins.length, cap: MAX_COINS });
    }

    return { coins, attribution: COINGECKO_ATTRIBUTION };
  },

  format: (result) => {
    if (result.coins.length === 0) {
      return [{ type: 'text', text: `_${result.attribution}_` }];
    }
    const lines = ['## Coin matches'];
    for (const c of result.coins) {
      const rank = c.marketCapRank != null ? ` · rank #${c.marketCapRank}` : '';
      lines.push(`- **${c.name}** (${c.symbol}) — id: \`${c.id}\`${rank}`);
      if (c.thumb) lines.push(`  - icon: ${c.thumb}`);
    }
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
