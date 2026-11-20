/**
 * @fileoverview CoinGecko market tool contracts exercised through real service normalization.
 * @module tests/mcp-server/tools/market-contracts.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMarketChartTool } from '@/mcp-server/tools/definitions/get-market-chart.tool.js';
import { getPricesTool } from '@/mcp-server/tools/definitions/get-prices.tool.js';
import { listCategoriesTool } from '@/mcp-server/tools/definitions/list-categories.tool.js';
import { listMarketsTool } from '@/mcp-server/tools/definitions/list-markets.tool.js';
import { initCoinGeckoService } from '@/services/coingecko/coingecko-service.js';

const fetchMock = vi.fn<(url: string) => Promise<Response>>();
const bitcoin = { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 1 };
const catalog = [
  { category_id: 'ape', name: 'ApeChain Ecosystem' },
  { category_id: '8bit', name: '8Bit Chain Ecosystem' },
  { category_id: 'ai-agents', name: 'AI Agents' },
  { category_id: 'ai', name: 'Artificial Intelligence (AI)' },
  { category_id: 'meme', name: 'Memes' },
  { category_id: 'defi-index', name: 'DéFi-Indexes' },
  { category_id: 'defi', name: 'DéFi' },
];
const chart = {
  prices: [
    [3600000, 1],
    [7200000, 2],
  ],
  market_caps: [],
  total_volumes: [],
};
const prices = { bitcoin: { usd: 1, eur: 2 }, ethereum: { usd: 3 } };

function reply(value: unknown): void {
  fetchMock.mockResolvedValueOnce(Response.json(value));
}

function request(index = 0): URL {
  return new URL(fetchMock.mock.calls[index]![0]);
}

function rendered(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => Response.json([]));
  vi.stubGlobal('fetch', fetchMock);
  initCoinGeckoService();
});

afterEach(() => vi.unstubAllGlobals());

it('keeps the unfiltered category catalog ordered and the default prices in USD', async () => {
  reply(catalog);
  reply({ bitcoin: prices.bitcoin });
  const categories = await runToolContract(listCategoriesTool, {});
  expect(categories.structuredContent?.categories).toEqual(
    catalog.map(({ category_id, name }) => ({ categoryId: category_id, name })),
  );
  expect(request().pathname).toContain('/coins/categories/list');
  expect(rendered(categories)).toContain('Full catalog: 7 categories.');
  const quotes = await runToolContract(getPricesTool, { ids: ['bitcoin'] });
  expect(quotes.structuredContent?.prices).toEqual([{ id: 'bitcoin', currency: 'usd', price: 1 }]);
  expect(rendered(quotes)).toContain('**bitcoin** (usd): 1');
  expect(request(1).searchParams.get('vs_currencies')).toBe('usd');
});

describe('price rows and normalized selectors', () => {
  it.each([false, true])(
    'preserves row timestamps and the oldest quoted row (reverse=%s)',
    async (reverse) => {
      const rows = {
        ethereum: { usd: 3, last_updated_at: 10 },
        bitcoin: { usd: 1, eur: 2, last_updated_at: 30 },
        unquoted: { last_updated_at: 5 },
        sparse: { eur: 4 },
      };
      const entries = Object.entries(rows);
      reply(Object.fromEntries(reverse ? entries.reverse() : entries));
      const result = await runToolContract(getPricesTool, {
        ids: ['ethereum', 'bitcoin', 'unquoted', 'sparse'],
        vs_currencies: ['usd', 'eur'],
      });
      expect(result.structuredContent?.prices).toHaveLength(4);
      expect(result.structuredContent?.prices).toEqual(
        expect.arrayContaining([
          { id: 'ethereum', currency: 'usd', price: 3, lastUpdatedAtUnixSec: 10 },
          { id: 'bitcoin', currency: 'usd', price: 1, lastUpdatedAtUnixSec: 30 },
          { id: 'bitcoin', currency: 'eur', price: 2, lastUpdatedAtUnixSec: 30 },
          { id: 'sparse', currency: 'eur', price: 4 },
        ]),
      );
      expect(result.structuredContent?.lastUpdatedAtUnixSec).toBe(10);
      const text = rendered(result);
      expect(text).toContain('**ethereum** (usd): 3 · updated 10 (Unix seconds)');
      expect(text).toContain('**bitcoin** (eur): 2 · updated 30 (Unix seconds)');
      expect(text).toContain('Oldest returned quote timestamp: 10 (Unix seconds)');
    },
  );

  it('normalizes packed IDs and currencies before lookup, keeping only first occurrences', async () => {
    reply(prices);
    const result = await runToolContract(getPricesTool, {
      ids: [' Bitcoin , , ETHEREUM', ' ', 'bitcoin'],
      vs_currencies: ['USD, eur', '', ' ,USD'],
    });
    expect(request().searchParams.get('ids')).toBe('bitcoin,ethereum');
    expect(request().searchParams.get('vs_currencies')).toBe('usd,eur');
    expect(result.structuredContent?.prices).toEqual([
      { id: 'bitcoin', currency: 'usd', price: 1 },
      { id: 'bitcoin', currency: 'eur', price: 2 },
      { id: 'ethereum', currency: 'usd', price: 3 },
    ]);
    expect(result.structuredContent).not.toHaveProperty('lastUpdatedAtUnixSec');
    expect(rendered(result)).toContain('**bitcoin** (eur): 2');
  });

  it('caps normalized price IDs and preserves the order of the skipped tail', async () => {
    const ids = Array.from({ length: 252 }, (_, i) => `id${i}`);
    reply({ id0: { usd: 1 } });
    const result = await runToolContract(getPricesTool, { ids: [ids.join(','), 'ID251, id0'] });
    expect(request().searchParams.get('ids')).toBe(ids.slice(0, 250).join(','));
    expect(result.structuredContent?.skippedIds).toEqual(['id250', 'id251']);
    expect(result.structuredContent?.missing).toEqual(ids.slice(1, 250));
    expect(rendered(result)).toContain('**Skipped IDs:** id250, id251');
  });

  it('caps packed market IDs and names absent rows separately from skipped input', async () => {
    const ids = ['bitcoin', ...Array.from({ length: 250 }, (_, i) => `id${i}`)];
    reply([bitcoin]);
    const result = await runToolContract(listMarketsTool, { ids: [ids.join(',')], per_page: 250 });
    expect(request().searchParams.get('ids')).toBe(ids.slice(0, 250).join(','));
    expect(result.structuredContent?.appliedIds).toEqual(ids.slice(0, 250));
    expect(result.structuredContent?.skippedIds).toEqual(['id249']);
    expect(result.structuredContent?.notReturnedIds).toEqual(ids.slice(1, 250));
    expect(rendered(result)).toContain('**Skipped IDs:** id249');
    expect(rendered(result)).toContain(`**IDs without a row:** ${ids.slice(1, 250).join(', ')}`);
  });

  it('reports absent IDs only on short first pages with an ID selection', async () => {
    const ids = ['bitcoin, Missing, Ethereum', 'missing'];
    for (const [input, rows, notReturnedIds] of [
      [{ ids }, [bitcoin], ['missing', 'ethereum']],
      [{ ids }, [], ['bitcoin', 'missing', 'ethereum']],
      [{ ids, per_page: 1 }, [bitcoin], undefined],
      [{ ids, page: 2 }, [], undefined],
      [{ category: 'layer-1' }, [], undefined],
      [{}, [], undefined],
    ] as const) {
      reply(rows);
      const result = await runToolContract(listMarketsTool, input);
      expect(result.structuredContent?.notReturnedIds).toEqual(notReturnedIds);
      if (notReturnedIds) expect(rendered(result)).toContain(notReturnedIds.join(', '));
      else expect(rendered(result)).not.toContain('**IDs without a row:**');
    }
  });

  it('keeps punctuation literal in market ID trailers', async () => {
    const ids = [
      'bitcoin',
      ...Array.from({ length: 248 }, (_, i) => `id${i}`),
      'asset*one*',
      'asset*two*',
    ];
    reply([bitcoin]);
    const result = await runToolContract(listMarketsTool, { ids, per_page: 250 });
    expect(result.structuredContent?.appliedIds).toEqual(ids.slice(0, 250));
    expect(result.structuredContent?.notReturnedIds).toEqual(ids.slice(1, 250));
    expect(result.structuredContent?.skippedIds).toEqual(['asset*two*']);
    const text = rendered(result);
    expect(text).toContain(`**Applied IDs:** ${ids.slice(0, 249).join(', ')}, asset\\*one\\*`);
    expect(text).toContain(
      `**IDs without a row:** ${ids.slice(1, 249).join(', ')}, asset\\*one\\*`,
    );
    expect(text).toContain('**Skipped IDs:** asset\\*two\\*');
  });

  it('rejects separator-only ID and currency lists before fetching', async () => {
    const cases = [
      await runToolContract(getPricesTool, { ids: [', ,'] }),
      await runToolContract(getPricesTool, { ids: ['bitcoin'], vs_currencies: [','] }),
      await runToolContract(listMarketsTool, { ids: [', ,'] }),
    ];
    for (const result of cases) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ data: { reason: 'empty_selector' } });
      expect(rendered(result)).toContain('at least one');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('applied chart windows', () => {
  it.each([
    [{ from: 1, to: 2 }, { mode: 'range', from: 1, to: 2 }, '/range', undefined],
    [
      { mode: 'range', from: 1, to: 2, days: 6 },
      { mode: 'range', from: 1, to: 2 },
      '/range',
      'days',
    ],
    [{ days: 7, from: 1, to: 2 }, { mode: 'recent', days: 7 }, '/market_chart', 'from, to'],
    [{ mode: 'recent', days: 'max', to: 2 }, { mode: 'recent', days: 365 }, '/market_chart', 'to'],
  ] as const)(
    'applies %j as %j and keeps chart pagination',
    async (input, window, route, ignored) => {
      reply(chart);
      const result = await runToolContract(getMarketChartTool, {
        id: 'bitcoin',
        ...input,
        point_limit: 1,
      });
      expect(result.structuredContent).toMatchObject({
        ...window,
        pointCount: 1,
        nextPointOffset: 1,
      });
      expect(request().pathname.endsWith(route)).toBe(true);
      if (window.mode === 'range') {
        expect(request().searchParams.get('from')).toBe('1');
        expect(request().searchParams.get('to')).toBe('2');
        expect(result.structuredContent).not.toHaveProperty('days');
      } else {
        expect(request().searchParams.get('days')).toBe(String(window.days));
        expect(result.structuredContent).not.toHaveProperty('from');
        expect(result.structuredContent).not.toHaveProperty('to');
      }
      const text = rendered(result);
      expect(text).toContain(
        window.mode === 'range' ? 'range, 1 to 2 (Unix seconds)' : `recent, ${window.days} days`,
      );
      expect(text).toContain('3600000 ms: 1');
      expect(text).toContain('refetch');
      if (ignored) {
        expect(result.structuredContent?.notice).toContain(`Ignored window fields: ${ignored}.`);
        expect(text).toContain(`Ignored window fields: ${ignored}.`);
      }
    },
  );

  it.each([
    { from: 2 },
    { from: 3, to: 2 },
    { mode: 'recent', from: 1, to: 2 },
    { mode: 'range', days: 7, from: 1 },
  ])('rejects invalid chart window %j before upstream', async (window) => {
    const result = await runToolContract(getMarketChartTool, { id: 'bitcoin', ...window });
    expect(result.structuredContent?.error).toMatchObject({ data: { reason: 'invalid_range' } });
    expect(rendered(result)).toContain('chronological order');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('category selection', () => {
  it.each([
    ['ai', ['ai-agents', 'ai']],
    ['meme', ['meme']],
    ['dÉfi index', ['defi-index']],
  ])('matches each %s token only at the start of a name word', async (name_contains, expected) => {
    reply(catalog);
    const result = await runToolContract(listCategoriesTool, { name_contains });
    expect(result.structuredContent?.categories).toEqual(
      catalog
        .filter(({ category_id }) => expected.includes(category_id))
        .map(({ category_id, name }) => ({ categoryId: category_id, name })),
    );
    const text = rendered(result);
    for (const id of expected) expect(text).toContain(`\`${id}\``);
    expect(text).not.toContain('Chain Ecosystem');
  });

  it('paginates the live market ranking after substring-free name and USD threshold filtering', async () => {
    const rows = [
      { id: 'outside', name: 'ApeChain', market_cap: 999 },
      {
        id: 'null',
        name: 'AI Null',
        market_cap: null,
        market_cap_change_24h: null,
        volume_24h: null,
        updated_at: null,
      },
      { id: 'omitted', name: 'AI Missing' },
      {
        id: 'first',
        name: 'AI First',
        market_cap: 100,
        market_cap_change_24h: 0,
        volume_24h: 0,
        updated_at: '2026-11-01T00:00:00Z',
        top_3_coins_id: ['bitcoin', 'ethereum'],
      },
      { id: 'below', name: 'AI Below', market_cap: 99 },
      { id: 'zero', name: 'AI Zero', market_cap: 0 },
      { id: 'second', name: 'AI Second', market_cap: 101 },
      { id: 'third', name: 'AI Third', market_cap: 102 },
    ];
    for (const [offset, expected] of [
      [0, 'first'],
      [1, 'second'],
      [2, 'third'],
      [3, undefined],
    ] as const) {
      reply(rows);
      const result = await runToolContract(listCategoriesTool, {
        include_market_data: true,
        name_contains: 'ai',
        order: 'market_cap_change_24h_desc',
        min_market_cap: 100,
        limit: 1,
        offset,
      });
      expect(request(offset).pathname.endsWith('/coins/categories')).toBe(true);
      expect(request(offset).searchParams.get('order')).toBe('market_cap_change_24h_desc');
      expect(result.structuredContent?.totalCount).toBe(8);
      expect(result.structuredContent?.categories).toHaveLength(expected ? 1 : 0);
      expect(result.structuredContent?.nextOffset).toBe(offset < 2 ? offset + 1 : undefined);
      const text = rendered(result);
      expect(text).toContain('refetch');
      if (expected) {
        expect(result.structuredContent?.categories).toMatchObject([{ categoryId: expected }]);
        expect(text).toContain(expected);
      }
      if (offset < 2) expect(text).toContain(`Next offset: ${offset + 1}`);
      if (offset === 0) {
        expect(result.structuredContent?.categories).toMatchObject([
          {
            marketCap: 100,
            marketCapChange24hPct: 0,
            volume24h: 0,
            updatedAt: '2026-11-01T00:00:00Z',
            topCoinIds: ['bitcoin', 'ethereum'],
          },
        ]);
        for (const value of ['100', '0%', 'volume 0', '2026-11-01T00:00:00Z', 'bitcoin, ethereum'])
          expect(text).toContain(value);
      }
    }
    reply(rows);
    const sparse = await runToolContract(listCategoriesTool, {
      include_market_data: true,
      offset: 1,
      limit: 2,
    });
    expect(sparse.structuredContent?.categories).toEqual([
      { categoryId: 'null', name: 'AI Null' },
      { categoryId: 'omitted', name: 'AI Missing' },
    ]);
    expect(rendered(sparse)).not.toContain('market cap');
    expect(request(4).searchParams.get('order')).toBe('market_cap_desc');
  });

  it('caps category pages at 250 and keeps an actual zero without a threshold', async () => {
    reply(
      Array.from({ length: 251 }, (_, i) => ({
        id: `cat${i}`,
        name: `Category ${i}`,
        market_cap: i,
      })),
    );
    const result = await runToolContract(listCategoriesTool, {
      include_market_data: true,
      limit: 250,
    });
    expect(result.structuredContent?.categories).toHaveLength(250);
    expect(result.structuredContent?.categories).toMatchObject([
      { categoryId: 'cat0', marketCap: 0 },
      ...Array.from({ length: 249 }, (_, i) => ({ categoryId: `cat${i + 1}` })),
    ]);
    expect(result.structuredContent?.nextOffset).toBe(250);
    expect(rendered(result)).toContain('market cap 0 USD');
    expect(rendered(result)).toContain('Next offset: 250');
    for (const input of [{ limit: 251 }, { offset: -1 }, { min_market_cap: 0 }]) {
      const invalid = await runToolContract(listCategoriesTool, {
        include_market_data: true,
        ...input,
      });
      expect(invalid.structuredContent?.error).toMatchObject({
        data: { reason: 'invalid_arguments' },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ order: 'market_cap_asc' }, { limit: 1 }, { offset: 0 }, { min_market_cap: 1 }])(
    'rejects market-only options without opting in (%j)',
    async (input) => {
      const result = await runToolContract(listCategoriesTool, input);
      expect(result.structuredContent?.error).toMatchObject({
        data: { reason: 'market_options_require_market_data' },
      });
      expect(rendered(result)).toContain('include_market_data');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
