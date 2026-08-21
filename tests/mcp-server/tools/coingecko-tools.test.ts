/**
 * @fileoverview Handler tests for the CoinGecko tools — the behaviors that aren't
 * pure service normalization: silent-miss surfacing (missing[] vs all_missing),
 * unknown_category mapping, coin_not_found, market-chart mode validation,
 * sections filtering, empty-result notices, and truncation disclosure. The
 * service is mocked so handlers are exercised in isolation.
 * @module tests/mcp-server/tools/coingecko-tools.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = {
  search: vi.fn(),
  simplePrice: vi.fn(),
  coinsMarkets: vi.fn(),
  coinDetail: vi.fn(),
  marketChart: vi.fn(),
  marketChartRange: vi.fn(),
  trending: vi.fn(),
  global: vi.fn(),
  categoriesList: vi.fn(),
};

vi.mock('@/services/coingecko/coingecko-service.js', () => ({
  getCoinGeckoService: () => svc,
}));

const { searchCoinsTool } = await import('@/mcp-server/tools/definitions/search-coins.tool.js');
const { getPricesTool } = await import('@/mcp-server/tools/definitions/get-prices.tool.js');
const { listMarketsTool } = await import('@/mcp-server/tools/definitions/list-markets.tool.js');
const { listCategoriesTool } = await import(
  '@/mcp-server/tools/definitions/list-categories.tool.js'
);
const { getCoinTool } = await import('@/mcp-server/tools/definitions/get-coin.tool.js');
const { getMarketChartTool } = await import(
  '@/mcp-server/tools/definitions/get-market-chart.tool.js'
);
const { getTrendingTool } = await import('@/mcp-server/tools/definitions/get-trending.tool.js');
const { getGlobalTool } = await import('@/mcp-server/tools/definitions/get-global.tool.js');

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
});

describe('coingecko_get_prices', () => {
  it('throws all_missing (NotFound) when every id is missing', async () => {
    svc.simplePrice.mockResolvedValueOnce({ rows: [], missing: ['nope1', 'nope2'] });
    const ctx = createMockContext({ errors: getPricesTool.errors });
    const input = getPricesTool.input.parse({ ids: ['nope1', 'nope2'] });
    await expect(getPricesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'all_missing' },
    });
  });

  it('surfaces a partial miss in output.missing + an enrichment notice (not an error)', async () => {
    svc.simplePrice.mockResolvedValueOnce({
      rows: [{ id: 'bitcoin', currency: 'usd', price: 100 }],
      missing: ['nope'],
      lastUpdatedAt: 123,
    });
    const ctx = createMockContext();
    const input = getPricesTool.input.parse({ ids: ['bitcoin', 'nope'] });
    const out = await getPricesTool.handler(input, ctx);
    expect(out.missing).toEqual(['nope']);
    expect(out.lastUpdatedAtUnixSec).toBe(123);
    expect(getEnrichment(ctx).notice).toContain('nope');
  });

  it('defaults vs_currencies to ["usd"]', () => {
    const input = getPricesTool.input.parse({ ids: ['bitcoin'] });
    expect(input.vs_currencies).toEqual(['usd']);
  });

  it('discloses a silently-dropped currency (no row for any coin) in the notice', async () => {
    // bitcoin resolved in usd, but the requested "notacurrency" returned no row —
    // upstream drops unknown currency codes silently, so disclose it.
    svc.simplePrice.mockResolvedValueOnce({
      rows: [{ id: 'bitcoin', currency: 'usd', price: 100 }],
      missing: [],
    });
    const ctx = createMockContext();
    const input = getPricesTool.input.parse({
      ids: ['bitcoin'],
      vs_currencies: ['usd', 'notacurrency'],
    });
    const out = await getPricesTool.handler(input, ctx);
    expect(out.missing).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('notacurrency');
  });
});

describe('coingecko_search_coins', () => {
  it('emits an empty-result notice when nothing matched', async () => {
    svc.search.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const out = await searchCoinsTool.handler(searchCoinsTool.input.parse({ query: 'zzz' }), ctx);
    expect(out.coins).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('zzz');
  });

  it('discloses truncation when more than the cap matched', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      symbol: 's',
      name: `n${i}`,
    }));
    svc.search.mockResolvedValueOnce(many);
    const ctx = createMockContext();
    const out = await searchCoinsTool.handler(searchCoinsTool.input.parse({ query: 'x' }), ctx);
    expect(out.coins).toHaveLength(25);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).cap).toBe(25);
  });

  it('leaves truncation enrichment unset for a small result (the SerializationError regression)', async () => {
    // A handful of matches must NOT populate truncated/shown/cap — those fields
    // are optional, so an unset value is a valid result, not a parse failure.
    svc.search.mockResolvedValueOnce([{ id: 'ethereum', symbol: 'eth', name: 'Ethereum' }]);
    const ctx = createMockContext();
    const out = await searchCoinsTool.handler(searchCoinsTool.input.parse({ query: 'eth' }), ctx);
    expect(out.coins).toHaveLength(1);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(getEnrichment(ctx).shown).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});

describe('coingecko_list_markets', () => {
  it('maps a null result (upstream 404 on a category) to unknown_category', async () => {
    // The service returns null only when a category-filtered request 404s.
    svc.coinsMarkets.mockResolvedValueOnce(null);
    const ctx = createMockContext({ errors: listMarketsTool.errors });
    const input = listMarketsTool.input.parse({ category: 'not-a-real-category' });
    await expect(listMarketsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unknown_category' },
    });
  });

  it('does NOT throw unknown_category for a legitimately empty page (valid category, page past end)', async () => {
    svc.coinsMarkets.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const out = await listMarketsTool.handler(
      listMarketsTool.input.parse({ category: 'real-cat', page: 99 }),
      ctx,
    );
    expect(out.coins).toEqual([]);
  });

  it('omits truncation enrichment when the page is not full (the SerializationError regression)', async () => {
    // Fewer rows than per_page must NOT populate truncated/shown/cap — those
    // enrichment fields are optional, so leaving them unset is a valid result.
    svc.coinsMarkets.mockResolvedValueOnce([{ id: 'c0', symbol: 's', name: 'n0' }]);
    const ctx = createMockContext();
    const out = await listMarketsTool.handler(listMarketsTool.input.parse({ per_page: 50 }), ctx);
    expect(out.coins).toHaveLength(1);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(getEnrichment(ctx).appliedOrder).toBe('market_cap_desc');
  });

  it('discloses truncation when the page filled to per_page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, symbol: 's', name: `n${i}` }));
    svc.coinsMarkets.mockResolvedValueOnce(rows);
    const ctx = createMockContext();
    const input = listMarketsTool.input.parse({ per_page: 5 });
    await listMarketsTool.handler(input, ctx);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).appliedOrder).toBe('market_cap_desc');
  });
});

describe('coingecko_list_categories', () => {
  const cats = [
    { categoryId: 'layer-1', name: 'Layer 1 (L1)' },
    { categoryId: 'decentralized-finance-defi', name: 'Decentralized Finance (DeFi)' },
    { categoryId: 'gaming', name: 'Gaming (GameFi)' },
  ];

  it('returns the full list and reports total when unfiltered', async () => {
    svc.categoriesList.mockResolvedValueOnce(cats);
    const ctx = createMockContext();
    const out = await listCategoriesTool.handler(listCategoriesTool.input.parse({}), ctx);
    expect(out.categories).toHaveLength(3);
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('filters by strict token match on the display name', async () => {
    svc.categoriesList.mockResolvedValueOnce(cats);
    const ctx = createMockContext();
    const input = listCategoriesTool.input.parse({ name_contains: 'defi' });
    const out = await listCategoriesTool.handler(input, ctx);
    expect(out.categories.map((c) => c.categoryId)).toEqual(['decentralized-finance-defi']);
  });

  it('emits a notice when the filter matched nothing', async () => {
    svc.categoriesList.mockResolvedValueOnce(cats);
    const ctx = createMockContext();
    const input = listCategoriesTool.input.parse({ name_contains: 'nonsense' });
    const out = await listCategoriesTool.handler(input, ctx);
    expect(out.categories).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('nonsense');
  });
});

const fullCoin = {
  id: 'bitcoin',
  symbol: 'btc',
  name: 'Bitcoin',
  profile: { categories: ['Layer 1 (L1)'], description: 'BTC' },
  market: { currentPrice: 100, priceChangePct: { d24h: 1 } },
  links: { homepage: ['https://bitcoin.org'], repos: [] },
  developer: { stars: 10 },
  community: { redditSubscribers: 5 },
  sentiment: { upPercentage: 80 },
};

describe('coingecko_get_coin', () => {
  it('throws coin_not_found (NotFound) when the service returns null', async () => {
    svc.coinDetail.mockResolvedValueOnce(null);
    const ctx = createMockContext({ errors: getCoinTool.errors });
    const input = getCoinTool.input.parse({ id: 'notacoin' });
    await expect(getCoinTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'coin_not_found' },
    });
  });

  it('returns only requested sections', async () => {
    svc.coinDetail.mockResolvedValueOnce(fullCoin);
    const ctx = createMockContext();
    const input = getCoinTool.input.parse({ id: 'bitcoin', sections: ['market', 'sentiment'] });
    const out = await getCoinTool.handler(input, ctx);
    expect(out.market).toBeDefined();
    expect(out.sentiment).toBeDefined();
    expect(out).not.toHaveProperty('profile');
    expect(out).not.toHaveProperty('links');
    expect(out).not.toHaveProperty('developer');
  });

  it('returns all sections when none specified', async () => {
    svc.coinDetail.mockResolvedValueOnce(fullCoin);
    const ctx = createMockContext();
    const out = await getCoinTool.handler(getCoinTool.input.parse({ id: 'bitcoin' }), ctx);
    for (const s of ['profile', 'market', 'links', 'developer', 'community', 'sentiment']) {
      expect(out).toHaveProperty(s);
    }
  });

  it('treats an empty sections array like omitted — returns all sections, not a bare record', async () => {
    // Form clients send [] for an unset array field; an empty selection that
    // stripped all data would be a silent footgun.
    svc.coinDetail.mockResolvedValueOnce(fullCoin);
    const ctx = createMockContext();
    const out = await getCoinTool.handler(
      getCoinTool.input.parse({ id: 'bitcoin', sections: [] }),
      ctx,
    );
    for (const s of ['profile', 'market', 'links', 'developer', 'community', 'sentiment']) {
      expect(out).toHaveProperty(s);
    }
  });
});

describe('coingecko_get_market_chart', () => {
  const chart = {
    prices: [{ t: 1700000000000, value: 100 }],
    marketCaps: [{ t: 1700000000000, value: 2000 }],
    volumes: [{ t: 1700000000000, value: 50 }],
  };

  it('throws invalid_range when mode=range without from/to', async () => {
    const ctx = createMockContext({ errors: getMarketChartTool.errors });
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'range' });
    await expect(getMarketChartTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_range' },
    });
  });

  it('computes daily granularity for a >90-day recent window', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const ctx = createMockContext();
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'recent', days: 180 });
    const out = await getMarketChartTool.handler(input, ctx);
    expect(out.granularity).toBe('daily');
    expect(out.pointCount).toBe(1);
  });

  it('computes hourly granularity for a 7-day recent window', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const ctx = createMockContext();
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'recent', days: 7 });
    const out = await getMarketChartTool.handler(input, ctx);
    expect(out.granularity).toBe('hourly');
  });

  it('uses range mode and throws coin_not_found when the service returns null', async () => {
    svc.marketChartRange.mockResolvedValueOnce(null);
    const ctx = createMockContext({ errors: getMarketChartTool.errors });
    const input = getMarketChartTool.input.parse({
      id: 'notacoin',
      mode: 'range',
      from: 1700000000,
      to: 1700086400,
    });
    await expect(getMarketChartTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'coin_not_found' },
    });
    expect(svc.marketChartRange).toHaveBeenCalledOnce();
  });
});

describe('coingecko_get_trending / get_global passthrough', () => {
  it('trending returns coins + nftCount + attribution', async () => {
    svc.trending.mockResolvedValueOnce({
      coins: [{ id: 'pepe', name: 'Pepe', symbol: 'PEPE' }],
      nftCount: 3,
    });
    const ctx = createMockContext();
    const out = await getTrendingTool.handler(getTrendingTool.input.parse({}), ctx);
    expect(out.coins).toHaveLength(1);
    expect(out.nftCount).toBe(3);
    expect(out.attribution).toMatch(/CoinGecko/);
  });

  it('global passes the selected currency through to the service', async () => {
    svc.global.mockResolvedValueOnce({
      totalMarketCap: 1,
      totalVolume24h: 2,
      btcDominance: 50,
      ethDominance: 10,
      activeCryptocurrencies: 100,
      markets: 200,
      ongoingIcos: 0,
      marketCapChangePercentage24h: 1,
      volumeChangePercentage24h: 2,
      updatedAtUnixSec: 123,
    });
    const ctx = createMockContext();
    const out = await getGlobalTool.handler(getGlobalTool.input.parse({ vs_currency: 'eur' }), ctx);
    expect(svc.global).toHaveBeenCalledWith('eur', ctx);
    expect(out.attribution).toMatch(/CoinGecko/);
  });
});

describe('format() does not throw on representative output', () => {
  it('every tool formats its sample without error', () => {
    expect(() =>
      searchCoinsTool.format?.({
        coins: [{ id: 'b', symbol: 's', name: 'B', marketCapRank: 1, thumb: 't' }],
        attribution: 'a',
      }),
    ).not.toThrow();
    expect(() =>
      getGlobalTool.format?.({
        totalMarketCap: 1,
        totalVolume24h: 2,
        btcDominance: 50,
        ethDominance: 10,
        activeCryptocurrencies: 1,
        markets: 1,
        ongoingIcos: 0,
        marketCapChangePercentage24h: 1,
        volumeChangePercentage24h: 2,
        updatedAtUnixSec: 1,
        attribution: 'a',
      }),
    ).not.toThrow();
  });
});

/** McpError is re-exported for assertion typing parity with the service test. */
void McpError;
