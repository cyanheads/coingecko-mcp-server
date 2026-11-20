/**
 * @fileoverview coingecko_search_coins — resolve coin names, tickers, or
 * platform-specific contract addresses to CoinGecko IDs.
 * @module src/mcp-server/tools/definitions/search-coins.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

/** Top slice returned — search yields many low-relevance tails. */
const MAX_COINS = 25;

export const searchCoinsTool = tool('coingecko_search_coins', {
  title: 'coingecko-mcp-server: search coins',
  description:
    'Resolve a coin name, ticker, or platform-specific contract address to a CoinGecko ID (slug). Use query for ranked name/ticker matches, or platform and contract_address for one token. Use the returned id in coin, price, market, and chart tools.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_coin_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The caller omitted a selector, combined a query with a contract selector, or supplied only one contract field.',
      recovery: 'Pass query alone, or pass both platform and contract_address without query.',
    },
    {
      reason: 'contract_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CoinGecko returned HTTP 404 for the supplied platform and contract address.',
      recovery:
        'Verify the CoinGecko asset platform ID and the exact contract address, including its casing.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Coin name or ticker symbol to resolve (e.g. "bitcoin", "ETH", "solana").'),
    platform: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'CoinGecko asset platform ID (e.g. "ethereum", "base", "tron"). See https://docs.coingecko.com/reference/asset-platforms for valid IDs.',
      ),
    contract_address: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Token contract address on the specified platform. Preserve its original casing.'),
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
    const { query, platform, contract_address: contractAddress } = input;
    if (query === undefined || platform !== undefined || contractAddress !== undefined) {
      if (query !== undefined || platform === undefined || contractAddress === undefined) {
        throw ctx.fail('invalid_coin_selector');
      }
      ctx.log.info('coingecko_search_coins contract lookup', { platform });
      const coin = await getCoinGeckoService().searchByContract(platform, contractAddress, ctx);
      if (!coin) throw ctx.fail('contract_not_found');
      return { coins: [coin], attribution: COINGECKO_ATTRIBUTION };
    }

    ctx.log.info('coingecko_search_coins', { query });
    const all = await getCoinGeckoService().search(query, ctx);
    const coins = all.slice(0, MAX_COINS);

    if (coins.length === 0) {
      ctx.enrich.notice(
        `No coin matched "${query}". Try a fuller name (e.g. "bitcoin" instead of a partial) or the ticker symbol.`,
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
