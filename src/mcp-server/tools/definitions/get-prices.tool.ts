/**
 * @fileoverview coingecko_get_prices — current price and core market stats for
 * one or more coins in one or more currencies. Diffs requested-vs-returned ids
 * to surface silent misses (a wrong slug returns 200-empty upstream, not an error).
 * @module src/mcp-server/tools/definitions/get-prices.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const getPricesTool = tool('coingecko_get_prices', {
  title: 'coingecko-mcp-server: get prices',
  description:
    'Current price and core market stats (market cap, 24h volume, 24h change) for one or more coins in one or more fiat/crypto currencies. Batch-friendly — pass a whole portfolio in one call (up to 250 ids). IDs must be CoinGecko slugs (bitcoin, ethereum), not tickers; resolve unknown tickers with coingecko_search_coins first. Any requested ids that returned no data are reported in the missing field (a wrong slug yields a silent upstream miss, not an error), so a typo reads as "unresolved", not "nonexistent".',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'all_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'No requested ID returned data — every slug was unknown or the upstream response was empty.',
      recovery:
        'Resolve tickers to slugs with coingecko_search_coins, then retry with the returned ids.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(250)
      .describe(
        'CoinGecko slugs to price (e.g. ["bitcoin","ethereum"]). Not tickers — resolve with coingecko_search_coins. Up to 250 per call.',
      ),
    vs_currencies: z
      .array(z.string().min(1))
      .min(1)
      .default(['usd'])
      .describe('Currency codes to price against (e.g. ["usd","eur","btc"]). Defaults to ["usd"].'),
  }),

  output: z.object({
    prices: z
      .array(
        z
          .object({
            id: z.string().describe('CoinGecko slug.'),
            currency: z.string().describe('Currency code this row is denominated in.'),
            price: z.number().describe('Current price in the row currency.'),
            marketCap: z
              .number()
              .optional()
              .describe('Market capitalization in the row currency, when available.'),
            vol24h: z
              .number()
              .optional()
              .describe('24-hour trading volume in the row currency, when available.'),
            change24h: z
              .number()
              .optional()
              .describe('24-hour price change as a percentage, when available.'),
          })
          .describe('Price and stats for one coin in one currency.'),
      )
      .describe(`One row per (id, currency) that returned a price. ${COINGECKO_ATTRIBUTION}.`),
    missing: z
      .array(z.string())
      .describe(
        'Requested ids absent from the response (unknown slug or upstream silent miss). Re-resolve these with coingecko_search_coins. Empty when all ids resolved.',
      ),
    lastUpdatedAtUnixSec: z
      .number()
      .optional()
      .describe(
        'Upstream last-updated time as a Unix timestamp in seconds (note: market-chart timestamps are milliseconds).',
      ),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when some requested ids returned no data — lists the missing ids and how to recover.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_prices', {
      idCount: input.ids.length,
      currencies: input.vs_currencies,
    });
    const result = await getCoinGeckoService().simplePrice(input.ids, input.vs_currencies, ctx);

    if (result.missing.length === input.ids.length) {
      throw ctx.fail(
        'all_missing',
        `None of the ${input.ids.length} requested id(s) returned data.`,
        { missing: result.missing, ...ctx.recoveryFor('all_missing') },
      );
    }

    // Currencies that returned no row for ANY resolved coin were silently dropped
    // upstream (an unsupported vs_currency yields no key rather than an error) —
    // disclose them so a bad currency code isn't mistaken for a flat market.
    const returnedCurrencies = new Set(result.rows.map((r) => r.currency));
    const droppedCurrencies = input.vs_currencies.filter((c) => !returnedCurrencies.has(c));

    const notices: string[] = [];
    if (result.missing.length > 0) {
      notices.push(
        `No data for id(s): ${result.missing.join(', ')}. These slugs are unknown to CoinGecko or returned a silent miss — re-resolve them with coingecko_search_coins (IDs are slugs like "bitcoin", not tickers like "BTC").`,
      );
    }
    if (droppedCurrencies.length > 0) {
      notices.push(
        `No data for currenc(ies): ${droppedCurrencies.join(', ')}. CoinGecko silently drops unsupported currency codes — check the code (e.g. "usd", "eur", "btc").`,
      );
    }
    if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      prices: result.rows,
      missing: result.missing,
      ...(result.lastUpdatedAt !== undefined && { lastUpdatedAtUnixSec: result.lastUpdatedAt }),
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = ['## Prices'];
    for (const r of result.prices) {
      const parts = [`**${r.id}** (${r.currency}): ${r.price}`];
      if (r.marketCap != null) parts.push(`cap ${r.marketCap}`);
      if (r.vol24h != null) parts.push(`vol24h ${r.vol24h}`);
      if (r.change24h != null) parts.push(`24h ${r.change24h}%`);
      lines.push(`- ${parts.join(' · ')}`);
    }
    if (result.missing.length > 0) {
      lines.push(`\n**Missing (no data):** ${result.missing.join(', ')}`);
    }
    if (result.lastUpdatedAtUnixSec != null) {
      lines.push(`\n_Last updated: ${result.lastUpdatedAtUnixSec} (Unix seconds)_`);
    }
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
