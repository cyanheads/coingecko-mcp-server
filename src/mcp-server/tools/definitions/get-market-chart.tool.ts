/**
 * @fileoverview coingecko_get_market_chart — historical price, market cap, and
 * volume time series. Two modes: recent (last N days, auto-granularity) or range
 * (explicit Unix-second from/to). Timestamps are MILLISECONDS.
 * @module src/mcp-server/tools/definitions/get-market-chart.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { type ChartGranularity, COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

/** Granularity CoinGecko auto-applies by span (recent mode). */
function recentGranularity(days: number | 'max'): ChartGranularity {
  if (days === 'max') return 'daily';
  if (days <= 1) return 'minutely';
  if (days <= 90) return 'hourly';
  return 'daily';
}

/** Granularity by span for an explicit range (same thresholds as recent). */
function rangeGranularity(fromSec: number, toSec: number): ChartGranularity {
  const days = (toSec - fromSec) / 86_400;
  if (days <= 1) return 'minutely';
  if (days <= 90) return 'hourly';
  return 'daily';
}

const PointSchema = z
  .object({
    t: z.number().describe('Timestamp in Unix MILLISECONDS (note: /simple/price uses seconds).'),
    value: z
      .number()
      .describe('Value at this timestamp (price, market cap, or volume in vs_currency).'),
  })
  .describe('One time-series point.');

export const getMarketChartTool = tool('coingecko_get_market_chart', {
  title: 'coingecko-mcp-server: get market chart',
  description:
    'Historical price, market cap, and volume time series for a coin. Two modes: recent (last N days; granularity auto-scales — ≤1 day → ~5-min, 2–90 → hourly, >90 → daily) or range (explicit Unix-second from/to). Returns timestamped point arrays. Use for trend/charting questions, not the current snapshot (use coingecko_get_prices for that). The id must be a CoinGecko slug (resolve tickers with coingecko_search_coins). Chart timestamps are milliseconds.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'coin_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned 404 for the slug — it is not a recognized CoinGecko id.',
      recovery:
        'Resolve the slug via coingecko_search_coins first — IDs are slugs (bitcoin), not tickers (BTC).',
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode/parameter mismatch — range mode without both from and to, or recent mode without days.',
      recovery: 'For mode=recent pass days; for mode=range pass both from and to as Unix seconds.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'CoinGecko slug (e.g. "bitcoin"). Not a ticker — resolve with coingecko_search_coins.',
      ),
    vs_currency: z
      .string()
      .min(1)
      .default('usd')
      .describe('Currency to denominate the series in. Single currency; defaults to "usd".'),
    mode: z
      .enum(['recent', 'range'])
      .default('recent')
      .describe(
        'recent: last N days (use days). range: explicit window (use from and to as Unix seconds).',
      ),
    days: z
      .union([
        z.number().int().min(1).describe('Number of days back from now.'),
        z.literal('max').describe('Full available history.'),
      ])
      .optional()
      .describe(
        'recent mode: number of days back, or "max" for full history. Required when mode=recent.',
      ),
    from: z
      .number()
      .int()
      .optional()
      .describe('range mode: start time as a Unix timestamp in SECONDS. Required when mode=range.'),
    to: z
      .number()
      .int()
      .optional()
      .describe('range mode: end time as a Unix timestamp in SECONDS. Required when mode=range.'),
  }),

  output: z.object({
    id: z.string().describe('CoinGecko slug the series is for.'),
    vsCurrency: z.string().describe('Currency the series is denominated in.'),
    granularity: z
      .enum(['minutely', 'hourly', 'daily'])
      .describe(
        'Point spacing CoinGecko applied for this span (computed from the requested range).',
      ),
    pointCount: z.number().describe('Number of price points returned.'),
    prices: z.array(PointSchema).describe(`Price series. ${COINGECKO_ATTRIBUTION}.`),
    marketCaps: z.array(PointSchema).describe('Market-cap series over the same window.'),
    volumes: z.array(PointSchema).describe('Volume series over the same window.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_market_chart', { id: input.id, mode: input.mode });
    const svc = getCoinGeckoService();

    let chart: Awaited<ReturnType<typeof svc.marketChart>>;
    let granularity: ChartGranularity;

    if (input.mode === 'range') {
      if (input.from == null || input.to == null) {
        throw ctx.fail('invalid_range', 'mode=range requires both from and to (Unix seconds).', {
          ...ctx.recoveryFor('invalid_range'),
        });
      }
      granularity = rangeGranularity(input.from, input.to);
      chart = await svc.marketChartRange(input.id, input.vs_currency, input.from, input.to, ctx);
    } else {
      if (input.days == null) {
        throw ctx.fail('invalid_range', 'mode=recent requires days.', {
          ...ctx.recoveryFor('invalid_range'),
        });
      }
      granularity = recentGranularity(input.days);
      chart = await svc.marketChart(input.id, input.vs_currency, input.days, ctx);
    }

    if (!chart) {
      throw ctx.fail('coin_not_found', `Coin "${input.id}" not found.`, {
        id: input.id,
        ...ctx.recoveryFor('coin_not_found'),
      });
    }

    return {
      id: input.id,
      vsCurrency: input.vs_currency,
      granularity,
      pointCount: chart.prices.length,
      prices: chart.prices,
      marketCaps: chart.marketCaps,
      volumes: chart.volumes,
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  // Summarize rather than dump every point — long series overflow context.
  format: (result) => {
    const lines = [
      `## ${result.id} — market chart (${result.vsCurrency})`,
      `**Granularity:** ${result.granularity} | **Points:** ${result.pointCount}`,
    ];
    const summarize = (label: string, pts: { t: number; value: number }[]) => {
      if (pts.length === 0) {
        lines.push(`**${label}:** (no points)`);
        return;
      }
      const first = pts[0];
      const last = pts[pts.length - 1];
      lines.push(
        `**${label}:** first ${first?.value} @ ${first?.t}ms → last ${last?.value} @ ${last?.t}ms`,
      );
    };
    summarize('Prices', result.prices);
    summarize('Market caps', result.marketCaps);
    summarize('Volumes', result.volumes);
    lines.push('\n_Timestamps are Unix milliseconds._');
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
