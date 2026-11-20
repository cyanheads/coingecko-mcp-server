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
import {
  type ChartGranularity,
  type ChartPoint,
  COINGECKO_ATTRIBUTION,
} from '@/services/coingecko/types.js';

/** Measure the complete original price series, before pagination. */
function cadence(points: ChartPoint[]): {
  granularity: ChartGranularity;
  observedIntervalInMs?: number;
} {
  const [first, ...rest] = points;
  if (!first || rest.length === 0) return { granularity: 'unknown' };
  const positive: number[] = [];
  let ordered = true;
  let previous = first;
  for (const point of rest) {
    const spacing = point.t - previous.t;
    if (spacing > 0) positive.push(spacing);
    else ordered = false;
    previous = point;
  }
  positive.sort((a, b) => a - b);
  if (positive.length === 0) return { granularity: 'irregular' };
  const center = positive.slice(
    Math.floor((positive.length - 1) / 2),
    Math.floor(positive.length / 2) + 1,
  );
  const observedIntervalInMs = center.reduce((sum, value) => sum + value, 0) / center.length;
  const bands = [
    ['5-minute', 300_000],
    ['hourly', 3_600_000],
    ['daily', 86_400_000],
  ] as const;
  const granularity = ordered
    ? (bands.find(
        ([, interval]) => Math.abs(observedIntervalInMs - interval) <= interval * 0.1,
      )?.[0] ?? 'irregular')
    : 'irregular';
  return { granularity, observedIntervalInMs };
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
    'Historical price, market cap, and volume in exact point pages (100 per series by default, cap 250). Recent mode accepts up to 365 days. Range mode accepts Unix-second from/to and is inferred when only a complete pair is supplied. The result reports the applied window. Choose auto, daily, or hourly interval subject to upstream availability. Cadence is measured from returned timestamps. Subsequent pages refetch upstream data and may shift. Resolve coin slugs with coingecko_search_coins. Chart timestamps are milliseconds.',
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
      when: 'Range mode lacks from/to, from exceeds to, or recent mode lacks days.',
      recovery:
        'For recent mode pass days up to 365; for range mode pass from and to in chronological order as Unix seconds.',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    id: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .describe(
        'CoinGecko slug (e.g. "bitcoin"). Not a ticker — resolve with coingecko_search_coins.',
      ),
    vs_currency: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .default('usd')
      .describe('Currency to denominate the series in. Single currency; defaults to "usd".'),
    mode: z
      .enum(['recent', 'range'])
      .optional()
      .describe(
        'recent: last N days (use days). range: explicit window (use from and to as Unix seconds). Omit to infer range from both endpoints without days; otherwise uses recent.',
      ),
    days: z
      .union([
        z.number().int().min(1).max(365).describe('Number of days back from now, up to 365.'),
        z.literal('max').describe('Alias for the 365-day keyless/Demo history window.'),
      ])
      .optional()
      .describe(
        'recent mode: 1–365 days back, or "max" as an alias for 365. Required when mode=recent.',
      ),
    interval: z
      .enum(['auto', 'daily', 'hourly'])
      .default('auto')
      .describe(
        'Observation interval; auto preserves CoinGecko defaults. Explicit availability depends on the upstream tier/window.',
      ),
    point_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index into each original series; use nextPointOffset to continue.'),
    point_limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe('Points per series; requests above 250 use 250 with a notice.'),
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
    mode: z.enum(['recent', 'range']).describe('Applied history mode.'),
    days: z.number().optional().describe('Applied lookback in days, present in recent mode.'),
    from: z.number().optional().describe('Applied start in Unix seconds, present in range mode.'),
    to: z.number().optional().describe('Applied end in Unix seconds, present in range mode.'),
    granularity: z
      .enum(['5-minute', 'hourly', 'daily', 'irregular', 'unknown'])
      .describe(
        'Observed cadence of the complete original price series; unknown with fewer than two observations.',
      ),
    observedIntervalInMs: z
      .number()
      .optional()
      .describe('Median positive adjacent timestamp spacing in milliseconds, when measurable.'),
    pricePointTotal: z.number().describe('Total price points before pagination.'),
    marketCapPointTotal: z.number().describe('Total market-cap points before pagination.'),
    volumePointTotal: z.number().describe('Total volume points before pagination.'),
    pointOffset: z.number().describe('Applied zero-based point offset.'),
    pointLimit: z.number().describe('Applied per-series point limit.'),
    nextPointOffset: z
      .number()
      .optional()
      .describe('Next index when any original series has more points.'),
    pointCount: z.number().describe('Number of price points returned.'),
    prices: z.array(PointSchema).describe(`Price series. ${COINGECKO_ATTRIBUTION}.`),
    marketCaps: z.array(PointSchema).describe('Market-cap series over the same window.'),
    volumes: z.array(PointSchema).describe('Volume series over the same window.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Largest original series count before point pagination.'),
    notice: z
      .string()
      .optional()
      .describe('Refetch semantics, applied caps, history aliases, and empty-page guidance.'),
  },

  async handler(input, ctx) {
    const mode =
      input.mode ??
      (input.days === undefined && input.from !== undefined && input.to !== undefined
        ? 'range'
        : 'recent');
    ctx.log.info('coingecko_get_market_chart', { id: input.id, mode });
    const svc = getCoinGeckoService();

    let chart: Awaited<ReturnType<typeof svc.marketChart>>;
    let window: { mode: 'range'; from: number; to: number } | { mode: 'recent'; days: number };
    const ignoredFields: string[] = [];

    if (mode === 'range') {
      if (input.from == null || input.to == null || input.from > input.to) {
        throw ctx.fail(
          'invalid_range',
          'mode=range requires from and to in chronological order (Unix seconds).',
        );
      }
      window = { mode, from: input.from, to: input.to };
      if (input.days !== undefined) ignoredFields.push('days');
      chart = await svc.marketChartRange(
        input.id,
        input.vs_currency,
        window.from,
        window.to,
        ctx,
        input.interval,
      );
    } else {
      if (input.days == null) {
        throw ctx.fail('invalid_range', 'mode=recent requires days.');
      }
      window = { mode, days: input.days === 'max' ? 365 : input.days };
      if (input.from !== undefined) ignoredFields.push('from');
      if (input.to !== undefined) ignoredFields.push('to');
      chart = await svc.marketChart(input.id, input.vs_currency, window.days, ctx, input.interval);
    }

    if (!chart) {
      throw ctx.fail('coin_not_found', `Coin "${input.id}" not found.`, {
        id: input.id,
      });
    }

    const pointLimit = Math.min(input.point_limit, 250);
    const end = input.point_offset + pointLimit;
    const total = Math.max(chart.prices.length, chart.marketCaps.length, chart.volumes.length);
    ctx.enrich.total(total);
    const notices = [
      'Subsequent pages refetch upstream data; observations may change and recent windows can move.',
    ];
    if (input.point_limit > 250)
      notices.push('Requested point_limit exceeds the effective cap of 250 per series.');
    if (ignoredFields.length > 0)
      notices.push(`Ignored window fields: ${ignoredFields.join(', ')}.`);
    if (input.days === 'max' && mode === 'recent')
      notices.push('days="max" uses the 365-day keyless/Demo history window.');
    if (input.point_offset >= total)
      notices.push('This page contains no points; use point_offset=0 or revise the window.');
    ctx.enrich.notice(notices.join(' '));
    const prices = chart.prices.slice(input.point_offset, end);
    return {
      id: input.id,
      vsCurrency: input.vs_currency,
      ...window,
      ...cadence(chart.prices),
      pricePointTotal: chart.prices.length,
      marketCapPointTotal: chart.marketCaps.length,
      volumePointTotal: chart.volumes.length,
      pointOffset: input.point_offset,
      pointLimit,
      ...(end < total && { nextPointOffset: end }),
      pointCount: prices.length,
      prices,
      marketCaps: chart.marketCaps.slice(input.point_offset, end),
      volumes: chart.volumes.slice(input.point_offset, end),
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.id} — market chart (${result.vsCurrency})`,
      `**Window:** ${result.mode}${result.days === undefined ? '' : `, ${result.days} days`}${result.from === undefined || result.to === undefined ? '' : `, ${result.from} to ${result.to} (Unix seconds)`}`,
      `**Granularity:** ${result.granularity} | **Points:** ${result.pointCount}`,
      `**Original totals:** prices ${result.pricePointTotal}, market caps ${result.marketCapPointTotal}, volumes ${result.volumePointTotal}`,
      `**Point offset:** ${result.pointOffset} | **Point limit:** ${result.pointLimit}`,
    ];
    if (result.observedIntervalInMs !== undefined)
      lines.push(`**Observed interval:** ${result.observedIntervalInMs} ms`);
    if (result.nextPointOffset !== undefined)
      lines.push(`**Next point offset:** ${result.nextPointOffset}`);
    const renderSeries = (label: string, pts: ChartPoint[]) => {
      if (pts.length === 0) {
        lines.push(`**${label}:** (no points)`);
        return;
      }
      lines.push(`**${label}:**`);
      for (const point of pts) lines.push(`- ${point.t} ms: ${point.value}`);
    };
    renderSeries('Prices', result.prices);
    renderSeries('Market caps', result.marketCaps);
    renderSeries('Volumes', result.volumes);
    lines.push('\n_Timestamps are Unix milliseconds._');
    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
