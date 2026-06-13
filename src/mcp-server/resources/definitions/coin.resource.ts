/**
 * @fileoverview coingecko://coin/{id} — deep coin record by slug, the same data
 * as coingecko_get_coin (full record, USD market figures) as injectable context.
 * @module src/mcp-server/resources/definitions/coin.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const coinResource = resource('coingecko://coin/{id}', {
  name: 'coingecko-mcp-server: coin record',
  description:
    'Deep coin record by CoinGecko slug — identity, market data (USD), links, developer activity, community stats, and sentiment. Same data as coingecko_get_coin. The {id} is a slug (e.g. "bitcoin"), not a ticker.',
  mimeType: 'application/json',

  errors: [
    {
      reason: 'coin_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned 404 for the slug — it is not a recognized CoinGecko id.',
      recovery:
        'Verify the slug with coingecko_search_coins — IDs are slugs (bitcoin), not tickers (BTC).',
    },
  ],

  params: z.object({
    id: z.string().min(1).describe('CoinGecko slug (e.g. "bitcoin").'),
  }),

  async handler(params, ctx) {
    ctx.log.debug('coingecko://coin resource', { id: params.id });
    const detail = await getCoinGeckoService().coinDetail(params.id, 'usd', ctx);
    if (!detail) {
      throw ctx.fail('coin_not_found', `Coin "${params.id}" not found.`, {
        id: params.id,
        ...ctx.recoveryFor('coin_not_found'),
      });
    }
    return { ...detail, attribution: COINGECKO_ATTRIBUTION };
  },

  list: () => ({
    resources: [
      { uri: 'coingecko://coin/bitcoin', name: 'Bitcoin record', mimeType: 'application/json' },
      { uri: 'coingecko://coin/ethereum', name: 'Ethereum record', mimeType: 'application/json' },
    ],
  }),
});
