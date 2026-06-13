/**
 * @fileoverview coingecko_list_categories — list CoinGecko's coin categories
 * (category_id + display name), the valid slugs for coingecko_list_markets's
 * category filter. ~800 categories; name_contains filters the complete list
 * locally by strict token match.
 * @module src/mcp-server/tools/definitions/list-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

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
    'List CoinGecko\'s coin categories (category_id + display name) — the valid slugs for coingecko_list_markets\'s category filter. ~800 categories; pass name_contains to filter the list locally by name (e.g. "defi", "layer 1", "gaming") with strict token matching, instead of scanning all of them. Use the returned category_id exactly when filtering markets.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [...COINGECKO_SERVICE_ERRORS],

  input: z.object({
    name_contains: z
      .string()
      .optional()
      .describe(
        'Local name filter — every whitespace-separated token must appear in the category display name (case-insensitive, punctuation-insensitive). Omit to return the full list.',
      ),
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
          })
          .describe('A coin category.'),
      )
      .describe(`Matching categories (full list when no filter). ${COINGECKO_ATTRIBUTION}.`),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total categories available upstream before any local filter.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the filter matched nothing — suggests browsing unfiltered.'),
  },

  async handler(input, ctx) {
    ctx.log.info('coingecko_list_categories', { nameContains: input.name_contains });
    const all = await getCoinGeckoService().categoriesList(ctx);
    ctx.enrich.total(all.length);

    const filter = input.name_contains?.trim();
    if (!filter) {
      return { categories: all, attribution: COINGECKO_ATTRIBUTION };
    }

    const tokens = normalize(filter).split(/\s+/).filter(Boolean);
    const categories = all.filter((c) => {
      const hay = normalize(c.name);
      return tokens.every((t) => hay.includes(t));
    });

    if (categories.length === 0) {
      ctx.enrich.notice(
        `No category name matched "${filter}". Call coingecko_list_categories without name_contains to browse the full list.`,
      );
    }

    return { categories, attribution: COINGECKO_ATTRIBUTION };
  },

  format: (result) => {
    if (result.categories.length === 0) {
      return [{ type: 'text', text: `_${result.attribution}_` }];
    }
    const lines = [`## Categories (${result.categories.length})`];
    for (const c of result.categories) {
      lines.push(`- \`${c.categoryId}\` — ${c.name}`);
    }
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
