/**
 * @fileoverview coingecko_list_categories — discover CoinGecko category slugs
 * and optionally page through an aggregate market ranking.
 * @module src/mcp-server/tools/definitions/list-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import {
  CATEGORY_MARKET_ORDERS,
  type CategoryMarket,
  COINGECKO_ATTRIBUTION,
} from '@/services/coingecko/types.js';

/** Normalize for token matching: lowercase, strip diacritics + punctuation. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
}

export const listCategoriesTool = tool('coingecko_list_categories', {
  title: 'coingecko-mcp-server: list categories',
  description:
    'Discover CoinGecko category slugs for coingecko_list_markets. Use name_contains to match the start of name words (e.g. "defi index"). Set include_market_data to rank categories by market cap or 24-hour cap change and page through filtered results. The market ranking can omit catalog categories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'market_options_require_market_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Order, min_market_cap, limit, or offset is present in catalog mode.',
      recovery: 'Set include_market_data to true or omit the market-only options.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    name_contains: z
      .string()
      .optional()
      .describe(
        'Each normalized search token must match the start of a category name word. Matching ignores case, accents, and punctuation.',
      ),
    include_market_data: z
      .boolean()
      .default(false)
      .describe(
        'Return aggregate market data and page the ranking. Defaults to false for catalog discovery.',
      ),
    order: z
      .enum(CATEGORY_MARKET_ORDERS)
      .optional()
      .describe('Market-data mode only. Upstream ranking order. Defaults to market_cap_desc.'),
    min_market_cap: z
      .number()
      .positive()
      .optional()
      .describe('Market-data mode only. Minimum reported market cap in USD, inclusive.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe('Market-data mode only. Rows per page, default 50 and maximum 250.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Market-data mode only. Zero-based offset after filtering, default 0.'),
  }),

  output: z.object({
    categories: z
      .array(
        z
          .object({
            categoryId: z
              .string()
              .describe(
                'Category slug — pass to coingecko_list_markets\'s category param (e.g. "layer-1").',
              ),
            name: z.string().describe('Display name (e.g. "Layer 1 (L1)").'),
            marketCap: z
              .number()
              .optional()
              .describe('Reported category market cap in USD, in market-data mode.'),
            marketCapChange24hPct: z
              .number()
              .optional()
              .describe('Reported 24-hour market cap change as a percentage, in market-data mode.'),
            volume24h: z
              .number()
              .optional()
              .describe('Reported 24-hour trading volume in USD, in market-data mode.'),
            updatedAt: z
              .string()
              .optional()
              .describe('Reported update time as an ISO 8601 timestamp, in market-data mode.'),
            topCoinIds: z
              .array(z.string())
              .optional()
              .describe('CoinGecko slugs of the category’s top coins, in market-data mode.'),
          })
          .describe('A coin category.'),
      )
      .describe(`Matching categories (full list when no filter). ${COINGECKO_ATTRIBUTION}.`),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset for the next page when more matching market-data rows remain.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total categories available upstream before any local filter.'),
    notice: z
      .string()
      .optional()
      .describe('Catalog narrowing, live ranking, and empty-result guidance.'),
  },

  async handler(input, ctx) {
    const { include_market_data, order, min_market_cap, limit, offset } = input;
    if (
      !include_market_data &&
      [order, min_market_cap, limit, offset].some((value) => value !== undefined)
    ) {
      throw ctx.fail('market_options_require_market_data');
    }
    ctx.log.info('coingecko_list_categories', {
      nameContains: input.name_contains,
      includeMarketData: include_market_data,
    });
    const service = getCoinGeckoService();
    const all: CategoryMarket[] = include_market_data
      ? await service.categoriesMarket(order ?? 'market_cap_desc', ctx)
      : await service.categoriesList(ctx);
    ctx.enrich.total(all.length);

    const filter = input.name_contains?.trim();
    const tokens = filter ? normalize(filter).split(/\s+/).filter(Boolean) : [];
    const categories =
      tokens.length > 0
        ? all.filter((category) => {
            const words = normalize(category.name).split(/\s+/);
            return tokens.every((token) => words.some((word) => word.startsWith(token)));
          })
        : all;

    if (!include_market_data) {
      if (!filter) {
        ctx.enrich.notice(
          `Full catalog: ${all.length} categories. Narrow discovery with name_contains, for example "gaming" or "layer 1".`,
        );
      } else if (categories.length === 0) {
        ctx.enrich.notice(
          `No category name matched "${escapeMarkdownInline(filter)}". Call coingecko_list_categories without name_contains to browse the full list.`,
        );
      }
      return { categories, attribution: COINGECKO_ATTRIBUTION };
    }

    const ranked =
      min_market_cap === undefined
        ? categories
        : categories.filter(
            (category) => category.marketCap !== undefined && category.marketCap >= min_market_cap,
          );
    const start = offset ?? 0;
    const end = start + (limit ?? 50);
    const page = ranked.slice(start, end);
    const notices = [
      'The market ranking can omit catalog categories. Later pages refetch the live ranking, so the order can change.',
    ];
    if (page.length === 0) {
      notices.push('This page contains no categories. Try offset=0 or broaden the filters.');
    }
    ctx.enrich.notice(notices.join(' '));
    return {
      categories: page,
      ...(end < ranked.length && { nextOffset: end }),
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  format: (result) => {
    if (result.categories.length === 0) {
      return [{ type: 'text', text: `_${result.attribution}_` }];
    }
    const lines = [`## Categories (${result.categories.length})`];
    for (const c of result.categories) {
      const details = [`\`${c.categoryId}\` — ${escapeMarkdownInline(c.name)}`];
      if (c.marketCap !== undefined) details.push(`market cap ${c.marketCap} USD`);
      if (c.marketCapChange24hPct !== undefined)
        details.push(`24h cap change ${c.marketCapChange24hPct}%`);
      if (c.volume24h !== undefined) details.push(`24h volume ${c.volume24h} USD`);
      if (c.updatedAt !== undefined) details.push(`updated ${escapeMarkdownInline(c.updatedAt)}`);
      if (c.topCoinIds !== undefined)
        details.push(`top coins: ${c.topCoinIds.map(escapeMarkdownInline).join(', ') || '(none)'}`);
      lines.push(`- ${details.join(' · ')}`);
    }
    if (result.nextOffset !== undefined) lines.push(`**Next offset: ${result.nextOffset}**`);
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
