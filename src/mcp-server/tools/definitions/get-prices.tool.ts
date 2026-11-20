/**
 * @fileoverview coingecko_get_prices — current price and core market stats for
 * one or more coins in one or more currencies. Diffs requested-vs-returned ids
 * to surface silent misses (a wrong slug returns 200-empty upstream, not an error).
 * @module src/mcp-server/tools/definitions/get-prices.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService, normalizeCsvList } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const getPricesTool = tool('coingecko_get_prices', {
  title: 'coingecko-mcp-server: get prices',
  description:
    'Current price and core market stats (market cap, 24h volume, 24h change) across coin/currency batches. Accepts up to 500 raw IDs, processes the first 250 unique normalized IDs, and discloses skipped IDs separately. IDs are CoinGecko slugs (bitcoin, ethereum); resolve unknown tickers with coingecko_search_coins first. Partial unresolved IDs appear in missing; all unresolved IDs or resolved coins without numeric quotes produce distinct errors.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'empty_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied IDs or currencies contain no values after comma splitting and trimming.',
      recovery: 'Supply at least one CoinGecko slug and one quote currency.',
    },
    {
      reason: 'no_price_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Some requested IDs resolved, but no numeric price was returned for the requested currencies.',
      recovery:
        'Check the requested currency codes or retry later; resolved coins may have no current quotes.',
    },
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
      .array(z.string())
      .min(1)
      .max(500)
      .describe(
        'CoinGecko slugs to price, as separate or comma-separated entries (e.g. ["bitcoin","ethereum"]). Accepts up to 500 raw entries; the first 250 unique normalized IDs are processed and the rest disclosed as skipped. Resolve tickers with coingecko_search_coins.',
      ),
    vs_currencies: z
      .array(z.string())
      .min(1)
      .default(['usd'])
      .describe(
        'Currency codes to price against, as separate or comma-separated entries (e.g. ["usd","eur","btc"]). Defaults to ["usd"].',
      ),
  }),

  output: z.object({
    prices: z
      .array(
        z
          .object({
            id: z.string().describe('CoinGecko slug.'),
            currency: z.string().describe('Currency code this row is denominated in.'),
            price: z.number().describe('Current price in the row currency.'),
            lastUpdatedAtUnixSec: z
              .number()
              .optional()
              .describe('Upstream last-updated time for this coin, in Unix seconds.'),
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
      .describe('Oldest reported last-updated time among returned quote rows, in Unix seconds.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    skippedIds: z
      .array(z.string())
      .optional()
      .describe('Normalized IDs beyond the 250 unique-ID processing cap; not upstream misses.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when some requested ids returned no data — lists the missing ids and how to recover.',
      ),
  },

  enrichmentTrailer: {
    skippedIds: { render: (ids) => (ids ? `**Skipped IDs:** ${ids.join(', ')}` : '') },
  },

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_prices', {
      idCount: input.ids.length,
      currencies: input.vs_currencies,
    });
    const uniqueIds = normalizeCsvList(input.ids);
    const currencies = normalizeCsvList(input.vs_currencies);
    if (uniqueIds.length === 0 || currencies.length === 0) throw ctx.fail('empty_selector');
    const ids = uniqueIds.slice(0, 250);
    const skippedIds = uniqueIds.slice(250);
    const result = await getCoinGeckoService().simplePrice(ids, currencies, ctx);

    if (result.missing.length === ids.length) {
      throw ctx.fail(
        'all_missing',
        `None of the ${ids.length} processed id(s) returned data.${skippedIds.length ? ` Skipped IDs beyond the cap: ${skippedIds.join(', ')}.` : ''}`,
        { missing: result.missing, skippedIds },
      );
    }
    if (result.rows.length === 0) {
      throw ctx.fail(
        'no_price_data',
        `Resolved coins returned no numeric quotes for ${currencies.join(', ')}.${result.missing.length ? ` Unresolved processed IDs: ${result.missing.join(', ')}.` : ''}${skippedIds.length ? ` Skipped IDs beyond the cap: ${skippedIds.join(', ')}.` : ''}`,
        { missing: result.missing, skippedIds },
      );
    }

    // Missing quotes can mean an unsupported currency or unavailable market data.
    const returnedCurrencies = new Set(result.rows.map((r) => r.currency));
    const droppedCurrencies = currencies.filter((c) => !returnedCurrencies.has(c));

    const notices: string[] = [];
    if (skippedIds.length > 0) {
      ctx.enrich({ skippedIds });
      notices.push(
        `Processed the first ${ids.length} unique IDs; ${skippedIds.length} IDs were skipped beyond the 250-ID cap.`,
      );
    }
    if (result.missing.length > 0) {
      notices.push(
        `No data for id(s): ${result.missing.join(', ')}. These slugs are unknown to CoinGecko or returned a silent miss — re-resolve them with coingecko_search_coins (IDs are slugs like "bitcoin", not tickers like "BTC").`,
      );
    }
    if (droppedCurrencies.length > 0) {
      notices.push(
        `No numeric quotes for currenc(ies): ${droppedCurrencies.join(', ')}. Check the currency codes or retry later; absence can also mean unavailable price data.`,
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
      if (r.lastUpdatedAtUnixSec !== undefined)
        parts.push(`updated ${r.lastUpdatedAtUnixSec} (Unix seconds)`);
      lines.push(`- ${parts.join(' · ')}`);
    }
    if (result.missing.length > 0) {
      lines.push(`\n**Missing (no data):** ${result.missing.join(', ')}`);
    }
    if (result.lastUpdatedAtUnixSec != null) {
      lines.push(
        `\n_Oldest returned quote timestamp: ${result.lastUpdatedAtUnixSec} (Unix seconds)_`,
      );
    }
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
