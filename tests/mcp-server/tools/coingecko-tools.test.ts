/**
 * @fileoverview Handler tests for the CoinGecko tools — the behaviors that aren't
 * pure service normalization: silent-miss surfacing (missing[] vs all_missing),
 * unknown_category mapping, coin_not_found, market-chart mode validation,
 * sections filtering, empty-result notices, and truncation disclosure. The
 * service is mocked so handlers are exercised in isolation.
 * @module tests/mcp-server/tools/coingecko-tools.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

vi.mock('@/services/coingecko/coingecko-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/coingecko/coingecko-service.js')>()),
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
const { coinResource } = await import('@/mcp-server/resources/definitions/coin.resource.js');
const { coinResearchPrompt } = await import(
  '@/mcp-server/prompts/definitions/coin-research.prompt.js'
);

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
});

describe('coingecko_get_prices', () => {
  it('normalizes and deduplicates inputs before processing (#13)', async () => {
    svc.simplePrice.mockResolvedValueOnce({
      rows: [{ id: 'bitcoin', currency: 'usd', price: 1 }],
      missing: [],
    });
    const run = await runToolContract(getPricesTool, {
      ids: [' Bitcoin ', 'bitcoin'],
      vs_currencies: [' USD ', 'usd'],
    });
    expect(run.isError).not.toBe(true);
    expect(svc.simplePrice).toHaveBeenCalledWith(['bitcoin'], ['usd'], expect.anything());
    expect(run.structuredContent?.missing).toEqual([]);
  });

  it('accepts bounded overflow and discloses skipped IDs on both surfaces (#13)', async () => {
    svc.simplePrice.mockResolvedValueOnce({
      rows: [{ id: 'c0', currency: 'usd', price: 1 }],
      missing: [],
    });
    const ids = Array.from({ length: 500 }, (_, i) => `c${i}`);
    const run = await runToolContract(getPricesTool, { ids });
    expect(run.isError).not.toBe(true);
    expect(svc.simplePrice).toHaveBeenCalledWith(ids.slice(0, 250), ['usd'], expect.anything());
    expect(run.structuredContent?.skippedIds).toEqual(ids.slice(250));
    const text = run.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text.split('\n')).toContain(`**Skipped IDs:** ${ids.slice(250).join(', ')}`);
    expect(run.structuredContent?.missing).toEqual([]);
    expect(getPricesTool.input.safeParse({ ids: [...ids, 'c500'] }).success).toBe(false);
  });

  it('rejects lists without a usable ID or currency before fetching (#13)', async () => {
    for (const input of [{ ids: [' '] }, { ids: ['bitcoin'], vs_currencies: [' '] }]) {
      const run = await runToolContract(getPricesTool, input);
      expect(run.structuredContent?.error).toMatchObject({ data: { reason: 'empty_selector' } });
    }
    expect(svc.simplePrice).not.toHaveBeenCalled();
  });

  it('uses no_price_data for a resolved coin without quotes (#13)', async () => {
    svc.simplePrice.mockResolvedValueOnce({ rows: [], missing: [] });
    const run = await runToolContract(getPricesTool, { ids: ['bitcoin'] });
    expect(run.isError).toBe(true);
    expect(run.structuredContent?.error).toMatchObject({ data: { reason: 'no_price_data' } });
  });
  it('preserves unresolved processed IDs when resolved coins have no quotes (#13)', async () => {
    svc.simplePrice.mockResolvedValueOnce({ rows: [], missing: ['unresolved-coin'] });
    const run = await runToolContract(getPricesTool, {
      ids: ['bitcoin', 'unresolved-coin'],
      vs_currencies: ['zzz'],
    });
    expect(run.structuredContent?.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_price_data', missing: ['unresolved-coin'], skippedIds: [] },
    });
    const text = run.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Unresolved processed IDs: unresolved-coin.');
  });
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
  it.each([{ ids: ['bitcoin'] }, { category: 'layer-1' }])(
    'preserves a single market selector %j (#15)',
    async (selector) => {
      svc.coinsMarkets.mockResolvedValueOnce([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }]);
      const run = await runToolContract(listMarketsTool, selector);
      expect(run.isError).not.toBe(true);
      expect(svc.coinsMarkets).toHaveBeenCalledWith(
        expect.objectContaining(selector),
        expect.anything(),
      );
      expect(run.structuredContent?.coins).toEqual([
        { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
      ]);
    },
  );

  it('rejects combined selectors before CoinGecko can ignore IDs (#15)', async () => {
    svc.coinsMarkets.mockResolvedValueOnce([{ id: 'zugchain', symbol: 'zug', name: 'ZugChain' }]);
    const run = await runToolContract(listMarketsTool, {
      ids: ['bitcoin', 'ethereum'],
      category: 'layer-1',
      order: 'id_desc',
      per_page: 1,
    });
    expect(run.isError).toBe(true);
    expect(run.structuredContent?.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'conflicting_filters',
        retryable: false,
        recovery: {
          hint: 'Use either ids or category. Omit category for portfolio IDs, or omit ids for a category ranking.',
        },
      },
    });
    expect(
      run.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    ).toContain('Omit category for portfolio IDs, or omit ids for a category ranking.');
    expect(svc.coinsMarkets).not.toHaveBeenCalled();
  });

  it('rejects blank IDs and raw overflow before fetching (#15)', async () => {
    for (const ids of [[' '], Array.from({ length: 501 }, (_, i) => `c${i}`)]) {
      const run = await runToolContract(listMarketsTool, { ids });
      expect(run.isError).toBe(true);
    }
    expect(svc.coinsMarkets).not.toHaveBeenCalled();
  });

  it('keeps requested IDs across pages without treating other-page IDs as missing (#15)', async () => {
    for (const [page, id] of [
      [1, 'bitcoin'],
      [2, 'ethereum'],
    ] as const) {
      svc.coinsMarkets.mockResolvedValueOnce([{ id, symbol: id, name: id }]);
      const run = await runToolContract(listMarketsTool, {
        ids: ['bitcoin', 'ethereum', 'fabricated'],
        page,
        per_page: 1,
      });
      expect(run.structuredContent?.coins).toEqual([{ id, symbol: id, name: id }]);
      expect(run.structuredContent).not.toHaveProperty('missing');
    }
  });
  it('forwards bounded normalized IDs with page/order and echoes without missing claims (#15)', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => `c${i}`);
    svc.coinsMarkets.mockResolvedValueOnce([{ id: 'c1', symbol: 's', name: 'N' }]);
    const run = await runToolContract(listMarketsTool, {
      ids: ids.map((id) => ` ${id.toUpperCase()} `),
      page: 2,
      order: 'id_asc',
    });
    expect(svc.coinsMarkets).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ids.slice(0, 250),
        page: 2,
        order: 'id_asc',
      }),
      expect.anything(),
    );
    expect(run.structuredContent?.appliedIds).toEqual(ids.slice(0, 250));
    expect(run.structuredContent?.skippedIds).toEqual(['c250']);
    expect(run.structuredContent).not.toHaveProperty('missing');
    const text = run.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text.split('\n')).toContain(`**Applied IDs:** ${ids.slice(0, 250).join(', ')}`);
    expect(text.split('\n')).toContain('**Skipped IDs:** c250');
  });

  it.each([1, 99])(
    'explains empty page %s without claiming a populated neighbor (#15)',
    async (page) => {
      svc.coinsMarkets.mockResolvedValueOnce([]);
      const run = await runToolContract(listMarketsTool, { ids: ['fabricated'], page });
      expect(run.structuredContent?.notice).toContain(`Page ${page} returned no rows`);
      const text = run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('page 1');
      expect(text).not.toMatch(/previous|last populated|missing coin/i);
    },
  );
  it.each(['price_change_percentage_24h_desc', 'price_change_percentage_24h_asc'])(
    'rejects unsupported order %s before fetching (#8)',
    async (order) => {
      const run = await runToolContract(listMarketsTool, { order });
      expect(run.isError).toBe(true);
      expect(svc.coinsMarkets).not.toHaveBeenCalled();
    },
  );

  it.each(['market_cap_asc', 'market_cap_desc', 'volume_asc', 'volume_desc', 'id_asc', 'id_desc'])(
    'forwards supported order %s (#8)',
    async (order) => {
      svc.coinsMarkets.mockResolvedValueOnce([]);
      const run = await runToolContract(listMarketsTool, { order });
      expect(run.isError).not.toBe(true);
      expect(svc.coinsMarkets).toHaveBeenCalledWith(
        expect.objectContaining({ order }),
        expect.anything(),
      );
      expect(run.structuredContent?.appliedOrder).toBe(order);
      expect(
        run.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      ).toContain(order);
    },
  );
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

  it.each([undefined, '', '   '])(
    'discloses complete catalog once for filter %j (#5)',
    async (name_contains) => {
      svc.categoriesList.mockResolvedValueOnce(cats);
      const run = await runToolContract(listCategoriesTool, { name_contains });
      expect(run.structuredContent?.categories).toEqual(cats);
      expect(run.structuredContent?.notice).toContain('Full catalog: 3 categories.');
      const text = run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text.match(/Full catalog/g)).toHaveLength(1);
      expect(text).toContain('name_contains');
    },
  );

  it('returns the full list and reports total when unfiltered', async () => {
    svc.categoriesList.mockResolvedValueOnce(cats);
    const ctx = createMockContext();
    const out = await listCategoriesTool.handler(listCategoriesTool.input.parse({}), ctx);
    expect(out.categories).toHaveLength(3);
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('filters by word prefix on the display name', async () => {
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
  it('decodes resource URI parameters once before normalizing (#13)', () => {
    expect(coinResource.params.parse({ id: '%20Bitcoin%20' }).id).toBe('bitcoin');
    expect(coinResource.params.parse({ id: '%2520Bitcoin' }).id).toBe('%20bitcoin');
    expect(coinResource.params.safeParse({ id: '%ZZ' }).success).toBe(false);
    expect(coinResource.params.safeParse({ id: '%20%20' }).success).toBe(false);
  });
  it('normalizes tool/resource slug and currency at their boundaries (#13)', async () => {
    svc.coinDetail.mockResolvedValue(fullCoin);
    const ctx = createMockContext();
    await getCoinTool.handler(
      getCoinTool.input.parse({ id: ' Bitcoin ', vs_currency: ' USD ' }),
      ctx,
    );
    expect(svc.coinDetail).toHaveBeenLastCalledWith('bitcoin', 'usd', ctx, true);
    await coinResource.handler(coinResource.params.parse({ id: ' Bitcoin ' }), ctx);
    expect(svc.coinDetail).toHaveBeenLastCalledWith('bitcoin', 'usd', ctx);
    expect(coinResource.params.safeParse({ id: ' ' }).success).toBe(false);
  });
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
  it('normalizes chart identity and forwards hourly interval (#6/#13)', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const run = await runToolContract(getMarketChartTool, {
      id: ' Bitcoin ',
      vs_currency: ' USD ',
      days: 1,
      interval: 'hourly',
    });
    expect(run.structuredContent?.id).toBe('bitcoin');
    expect(run.structuredContent?.vsCurrency).toBe('usd');
    expect(svc.marketChart).toHaveBeenCalledWith('bitcoin', 'usd', 1, expect.anything(), 'hourly');
    const messages = coinResearchPrompt.generate({ coin: 'Bitcoin' });
    expect(
      messages
        .map((m) => m.content)
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n'),
    ).toContain('interval=daily');
  });

  it('characterizes complete chart arrays before pagination', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const run = await runToolContract(getMarketChartTool, { id: 'bitcoin', days: 7 });
    expect(run.structuredContent?.prices).toEqual(chart.prices);
    expect(run.structuredContent?.marketCaps).toEqual(chart.marketCaps);
    expect(run.structuredContent?.volumes).toEqual(chart.volumes);
  });

  it('recovers unequal exact series over successive pages (#6)', async () => {
    const fixture = {
      prices: Array.from({ length: 7 }, (_, i) => ({ t: i * 3600000, value: i + 100 })),
      marketCaps: Array.from({ length: 10 }, (_, i) => ({ t: i * 3600000, value: i + 2000 })),
      volumes: [],
    };
    const recovered = { prices: [], marketCaps: [], volumes: [] } as typeof fixture;
    for (const offset of [0, 3, 6, 9, 12]) {
      svc.marketChart.mockResolvedValueOnce(fixture);
      const run = await runToolContract(getMarketChartTool, {
        id: 'bitcoin',
        days: 7,
        point_limit: 3,
        point_offset: offset,
      });
      expect(run.isError).not.toBe(true);
      const out = run.structuredContent as Record<string, unknown>;
      const text = run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (const key of ['prices', 'marketCaps', 'volumes'] as const) {
        const points = out[key] as typeof fixture.prices;
        expect(points).toEqual(fixture[key].slice(offset, offset + 3));
        recovered[key].push(...points);
        for (const point of points)
          expect(text.split('\n')).toContain(`- ${point.t} ms: ${point.value}`);
      }
      expect(out.nextPointOffset).toBe(offset + 3 < 10 ? offset + 3 : undefined);
      expect(out.granularity).toBe('hourly');
      expect(out.observedIntervalInMs).toBe(3600000);
      expect(out.pricePointTotal).toBe(7);
      expect(out.marketCapPointTotal).toBe(10);
      expect(out.volumePointTotal).toBe(0);
      expect(out.pointCount).toBe(fixture.prices.slice(offset, offset + 3).length);
      if (offset === 12)
        expect(text).toContain(
          'This page contains no points; use point_offset=0 or revise the window.',
        );
    }
    expect(recovered).toEqual(fixture);
  });

  it.each([-1, 0.5])('rejects invalid point offsets %s (#6)', (point_offset) => {
    expect(
      getMarketChartTool.input.safeParse({ id: 'bitcoin', days: 7, point_offset }).success,
    ).toBe(false);
  });
  it.each([0, -1, 0.5])('rejects invalid point limits %s (#6)', (point_limit) => {
    expect(
      getMarketChartTool.input.safeParse({ id: 'bitcoin', days: 7, point_limit }).success,
    ).toBe(false);
  });

  it.each([
    [undefined, 100],
    [250, 250],
    [500, 250],
  ] as const)(
    'applies point_limit=%s as %s with exact rows (#6)',
    async (point_limit, effectiveLimit) => {
      const points = Array.from({ length: 251 }, (_, i) => ({ t: i * 3600000, value: i }));
      svc.marketChart.mockResolvedValueOnce({ prices: points, marketCaps: [], volumes: [] });
      const run = await runToolContract(getMarketChartTool, {
        id: 'bitcoin',
        days: 7,
        ...(point_limit !== undefined && { point_limit }),
      });
      expect(run.structuredContent?.prices).toHaveLength(effectiveLimit);
      expect(run.structuredContent?.pointLimit).toBe(effectiveLimit);
      expect(run.structuredContent?.nextPointOffset).toBe(effectiveLimit);
      if (point_limit === 500)
        expect(run.structuredContent?.notice).toContain('effective cap of 250 per series');
      const text = run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text.split('\n').filter((line) => line.startsWith('- '))).toEqual(
        points.slice(0, effectiveLimit).map((point) => `- ${point.t} ms: ${point.value}`),
      );
      expect(run.structuredContent?.pricePointTotal).toBe(251);
    },
  );

  it('maps max to 365 with disclosure and rejects 366 (#10)', async () => {
    expect(getMarketChartTool.input.safeParse({ id: 'bitcoin', days: 366 }).success).toBe(false);
    svc.marketChart.mockResolvedValueOnce(chart);
    const run = await runToolContract(getMarketChartTool, { id: 'bitcoin', days: 'max' });
    expect(svc.marketChart).toHaveBeenCalledWith('bitcoin', 'usd', 365, expect.anything(), 'auto');
    expect(run.structuredContent?.notice).toContain('365');
    expect(
      run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).toContain('365');
  });

  it('rejects inverted ranges but forwards equal and future endpoints (#10)', async () => {
    const invalid = await runToolContract(getMarketChartTool, {
      id: 'bitcoin',
      mode: 'range',
      from: 2,
      to: 1,
    });
    expect(invalid.isError).toBe(true);
    expect(svc.marketChartRange).not.toHaveBeenCalled();
    for (const [from, to] of [
      [1, 1],
      [2000000000, 2000000001],
    ]) {
      svc.marketChartRange.mockResolvedValueOnce(chart);
      const run = await runToolContract(getMarketChartTool, {
        id: 'bitcoin',
        mode: 'range',
        from,
        to,
        interval: 'daily',
      });
      expect(run.isError).not.toBe(true);
      expect(svc.marketChartRange).toHaveBeenLastCalledWith(
        'bitcoin',
        'usd',
        from,
        to,
        expect.anything(),
        'daily',
      );
    }
  });

  it.each([
    [[], 'unknown', undefined],
    [[0], 'unknown', undefined],
    [[0, 300000, 601000], '5-minute', 300500],
    [[0, 3600000, 7200000], 'hourly', 3600000],
    [[0, 86400000, 172800000], 'daily', 86400000],
    [[0, 1000, 3000], 'irregular', 1500],
    [[0, 0, 3600000], 'irregular', 3600000],
    [[100, 0, 3600000], 'irregular', 3600000],
  ])('measures cadence of %j (#11)', async (timestamps, granularity, interval) => {
    svc.marketChart.mockResolvedValueOnce({
      prices: timestamps.map((t) => ({ t, value: 1 })),
      marketCaps: [],
      volumes: [],
    });
    const run = await runToolContract(getMarketChartTool, { id: 'bitcoin', days: 7 });
    expect(run.structuredContent?.granularity).toBe(granularity);
    expect(run.structuredContent?.observedIntervalInMs).toBe(interval);
    const lines = run.content.filter((b) => b.type === 'text').flatMap((b) => b.text.split('\n'));
    expect(lines).toContain(`**Granularity:** ${granularity} | **Points:** ${timestamps.length}`);
    if (interval !== undefined) expect(lines).toContain(`**Observed interval:** ${interval} ms`);
    else expect(lines.some((line) => line.startsWith('**Observed interval:**'))).toBe(false);
  });

  it('throws invalid_range when mode=range without from/to', async () => {
    const ctx = createMockContext({ errors: getMarketChartTool.errors });
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'range' });
    await expect(getMarketChartTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_range' },
    });
  });

  it('does not infer cadence from a 180-day request with one observation', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const ctx = createMockContext();
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'recent', days: 180 });
    const out = await getMarketChartTool.handler(input, ctx);
    expect(out.granularity).toBe('unknown');
    expect(out.pointCount).toBe(1);
  });

  it('does not infer cadence from a 7-day request with one observation', async () => {
    svc.marketChart.mockResolvedValueOnce(chart);
    const ctx = createMockContext();
    const input = getMarketChartTool.input.parse({ id: 'bitcoin', mode: 'recent', days: 7 });
    const out = await getMarketChartTool.handler(input, ctx);
    expect(out.granularity).toBe('unknown');
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
  it('normalizes global currency (#13)', async () => {
    svc.global.mockResolvedValueOnce({ dominance: [] });
    const ctx = createMockContext();
    await getGlobalTool.handler(getGlobalTool.input.parse({ vs_currency: ' USD ' }), ctx);
    expect(svc.global).toHaveBeenCalledWith('usd', ctx);
    expect(getGlobalTool.input.safeParse({ vs_currency: ' ' }).success).toBe(false);
  });
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
      dominance: [],
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
        dominance: [],
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

describe('declared recovery reaches the client', () => {
  it('fills each handler reason without throw-site forwarding', async () => {
    svc.simplePrice.mockResolvedValueOnce({ rows: [], missing: ['nope'] });
    svc.coinsMarkets.mockResolvedValueOnce(null);
    svc.coinDetail.mockResolvedValueOnce(null);
    svc.marketChart.mockResolvedValueOnce(null);
    const runs = [
      await runToolContract(getPricesTool, { ids: ['nope'] }),
      await runToolContract(listMarketsTool, { category: 'nope' }),
      await runToolContract(getCoinTool, { id: 'nope' }),
      await runToolContract(getMarketChartTool, { id: 'nope', days: 7 }),
      await runToolContract(getMarketChartTool, { id: 'bitcoin', mode: 'range' }),
      await runToolContract(getMarketChartTool, { id: 'bitcoin', mode: 'recent' }),
    ];
    const definitions = [
      getPricesTool,
      listMarketsTool,
      getCoinTool,
      getMarketChartTool,
      getMarketChartTool,
      getMarketChartTool,
    ];
    for (const [index, run] of runs.entries()) {
      expect(run.isError).toBe(true);
      const error = run.structuredContent?.error as {
        data: { reason: string; recovery: { hint: string } };
      };
      const contract = definitions[index]?.errors?.find(
        (entry) => entry.reason === error.data.reason,
      );
      expect(error.data.recovery.hint).toBe(contract?.recovery);
      expect(run.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining(error.data.recovery.hint),
          }),
        ]),
      );
    }
  });
});

/** McpError is re-exported for assertion typing parity with the service test. */
void McpError;
