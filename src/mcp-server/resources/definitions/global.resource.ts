/**
 * @fileoverview coingecko://global — global crypto market snapshot (USD), the
 * same data as coingecko_get_global, as injectable context.
 * @module src/mcp-server/resources/definitions/global.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

export const globalResource = resource('coingecko://global', {
  name: 'coingecko-mcp-server: global market',
  description:
    'Global crypto market snapshot (USD): total market cap and 24h volume, BTC/ETH dominance, active-coin and market counts, ongoing ICOs, and 24h change. Same data as coingecko_get_global.',
  mimeType: 'application/json',

  params: z.object({}),

  async handler(_params, ctx) {
    ctx.log.debug('coingecko://global resource');
    const g = await getCoinGeckoService().global('usd', ctx);
    return { ...g, attribution: COINGECKO_ATTRIBUTION };
  },

  list: () => ({
    resources: [
      { uri: 'coingecko://global', name: 'Global crypto market', mimeType: 'application/json' },
    ],
  }),
});
