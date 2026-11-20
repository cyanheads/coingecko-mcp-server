/**
 * @fileoverview Tests for CoinGeckoService — normalization, silent-miss
 * detection, sparse-payload handling, and HTTP error classification. Mocks
 * `fetchWithTimeout` so no live API calls are made.
 * @module tests/services/coingecko/coingecko-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return { ...actual, fetchWithTimeout: mockFetchWithTimeout };
});

const { CoinGeckoApiClient } = await import('@/services/coingecko/api-client.js');
const { CoinGeckoService } = await import('@/services/coingecko/coingecko-service.js');
const { COINGECKO_SERVICE_ERRORS } = await import('@/services/coingecko/error-contracts.js');
const { defaultIsTransient } = await import('@cyanheads/mcp-ts-core/utils');

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Status → JsonRpcErrorCode for the statuses these tests exercise (mirrors the
 * framework's `httpStatusToErrorCode`; inlined to avoid importing from the mocked
 * utils module, which would hoist above the mock factory). */
const STATUS_CODE: Record<number, JsonRpcErrorCode> = {
  404: JsonRpcErrorCode.NotFound,
  429: JsonRpcErrorCode.RateLimited,
  500: JsonRpcErrorCode.ServiceUnavailable,
  503: JsonRpcErrorCode.ServiceUnavailable,
};

/**
 * Mirror `fetchWithTimeout`'s real contract: it THROWS a classified `McpError` on
 * any non-OK status (it only ever resolves an OK `Response`). The api-client keys
 * off the thrown error's code, so a faithful fake must throw here — a fake that
 * resolved a non-OK `Response` would test a code path the framework never runs.
 */
function fetchHttpError(status: number, body = ''): McpError {
  const code = STATUS_CODE[status] ?? JsonRpcErrorCode.InternalError;
  return new McpError(
    code,
    `Fetch failed for https://api.coingecko.com/api/v3/x. Status: ${status}`,
    {
      statusCode: status,
      responseBody: body,
      errorSource: 'FetchHttpError',
    },
  );
}

function makeService() {
  return new CoinGeckoService(new CoinGeckoApiClient({ timeoutMs: 5000 }));
}

const ctx = createMockContext();

beforeEach(() => mockFetchWithTimeout.mockReset());

describe('search', () => {
  it.each([
    ['..', 'AbCdEf'],
    ['solana', '.'],
  ])('rejects a URL dot segment before resolving a contract', async (platform, contractAddress) => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({ id: 'token', symbol: 't', name: 'Token' }),
    );
    await expect(
      makeService().searchByContract(platform, contractAddress, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('resolves a case-sensitive contract on the requested platform and handles 404', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({ id: 'sample', symbol: 's', name: 'Sample', market_cap_rank: 12 }),
      )
      .mockRejectedValueOnce(fetchHttpError(404));
    const service = makeService();
    expect(await service.searchByContract(' Solana ', 'AbCdEf', ctx)).toEqual({
      id: 'sample',
      symbol: 's',
      name: 'Sample',
      marketCapRank: 12,
    });
    expect(new URL(mockFetchWithTimeout.mock.calls[0]?.[0]).pathname).toBe(
      '/api/v3/coins/solana/contract/AbCdEf',
    );
    expect(await service.searchByContract('solana', 'Missing', ctx)).toBeNull();
  });

  it('normalizes coins and preserves absence of rank/thumb', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        coins: [
          { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', market_cap_rank: 2, thumb: 'x.png' },
          { id: 'somecoin', name: 'Some Coin', symbol: 'SOME', market_cap_rank: null },
        ],
      }),
    );
    const out = await makeService().search('eth', ctx);
    expect(out).toEqual([
      { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', marketCapRank: 2, thumb: 'x.png' },
      { id: 'somecoin', name: 'Some Coin', symbol: 'SOME' },
    ]);
  });
});

describe('simplePrice — silent-miss detection', () => {
  it('uses the oldest returned quote timestamp regardless of upstream order', async () => {
    const bitcoin = { usd: 1, eur: 2, last_updated_at: 100 };
    const ethereum = { usd: 3, last_updated_at: 200 };
    const unquoted = { last_updated_at: 10 };
    mockFetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ bitcoin, ethereum, unquoted }))
      .mockResolvedValueOnce(jsonResponse({ ethereum, bitcoin, unquoted }));
    const service = makeService();
    for (const _ of [0, 1]) {
      const out = await service.simplePrice(
        ['bitcoin', 'ethereum', 'unquoted'],
        ['usd', 'eur'],
        ctx,
      );
      expect(out.lastUpdatedAt).toBe(100);
      expect(out.rows).toEqual(
        expect.arrayContaining([
          { id: 'bitcoin', currency: 'usd', price: 1, lastUpdatedAtUnixSec: 100 },
          { id: 'bitcoin', currency: 'eur', price: 2, lastUpdatedAtUnixSec: 100 },
          { id: 'ethereum', currency: 'usd', price: 3, lastUpdatedAtUnixSec: 200 },
        ]),
      );
    }
  });

  it('normalizes packed IDs and currencies for lookup and missing metadata', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ bitcoin: { usd: 1, eur: 2 } }));
    const out = await makeService().simplePrice(
      [' Bitcoin, ETHereum , ,bitcoin'],
      [' USD,EUR,usd'],
      ctx,
    );
    expect(out.rows.map((row) => row.currency)).toEqual(['usd', 'eur']);
    expect(out.missing).toEqual(['ethereum']);
    const url = new URL(mockFetchWithTimeout.mock.calls[0]?.[0]);
    expect(url.searchParams.get('ids')).toBe('bitcoin,ethereum');
    expect(url.searchParams.get('vs_currencies')).toBe('usd,eur');
  });

  it('normalizes IDs/currencies before request and missing comparison (#13)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ bitcoin: { usd: 1 } }));
    const out = await makeService().simplePrice([' Bitcoin ', 'bitcoin'], [' USD ', 'usd'], ctx);
    expect(out.rows).toEqual([{ id: 'bitcoin', currency: 'usd', price: 1 }]);
    expect(out.missing).toEqual([]);
    const url = new URL(mockFetchWithTimeout.mock.calls[0]?.[0]);
    expect(url.searchParams.get('ids')).toBe('bitcoin');
    expect(url.searchParams.get('vs_currencies')).toBe('usd');
  });
  it('flattens rows and reports a wrong slug as missing (200 {} upstream)', async () => {
    // bitcoin present; "notacoin" omitted entirely by upstream.
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        bitcoin: {
          usd: 63881,
          usd_market_cap: 1.28e12,
          usd_24h_vol: 2.22e10,
          usd_24h_change: 0.196,
          last_updated_at: 1781351543,
        },
      }),
    );
    const out = await makeService().simplePrice(['bitcoin', 'notacoin'], ['usd'], ctx);
    expect(out.rows).toEqual([
      {
        id: 'bitcoin',
        currency: 'usd',
        price: 63881,
        marketCap: 1.28e12,
        vol24h: 2.22e10,
        change24h: 0.196,
        lastUpdatedAtUnixSec: 1781351543,
      },
    ]);
    expect(out.missing).toEqual(['notacoin']);
    expect(out.lastUpdatedAt).toBe(1781351543);
  });

  it('drops a silently-omitted currency key without marking the coin missing', async () => {
    // eur requested but dropped by upstream (bad currency → key absent).
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ bitcoin: { usd: 63881 } }));
    const out = await makeService().simplePrice(['bitcoin'], ['usd', 'eur'], ctx);
    expect(out.rows).toEqual([{ id: 'bitcoin', currency: 'usd', price: 63881 }]);
    expect(out.missing).toEqual([]); // coin resolved; only the eur currency dropped
    expect(out).not.toHaveProperty('lastUpdatedAt');
  });

  it('reports every id as missing on a total 200 {} miss', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({}));
    const out = await makeService().simplePrice(['nope1', 'nope2'], ['usd'], ctx);
    expect(out.rows).toEqual([]);
    expect(out.missing).toEqual(['nope1', 'nope2']);
  });
});

describe('coinsMarkets', () => {
  it('sends IDs with order and pagination (#15)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse([]));
    await makeService().coinsMarkets(
      {
        ids: [' Bitcoin , ,ETHEREUM', 'bitcoin'],
        vsCurrency: ' USD ',
        order: 'id_asc',
        page: 2,
        perPage: 1,
      },
      ctx,
    );
    const url = new URL(mockFetchWithTimeout.mock.calls[0]?.[0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ids: 'bitcoin,ethereum',
      vs_currency: 'usd',
      order: 'id_asc',
      page: '2',
      per_page: '1',
    });
  });

  it('rejects an explicitly empty normalized ID selection before fetching', async () => {
    const input = { ids: [' , , '], vsCurrency: 'usd', order: 'id_asc', page: 1, perPage: 50 };
    await expect(makeService().coinsMarkets(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
  it('normalizes and omits null fields; prefers in-currency 24h change', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          current_price: 63881,
          market_cap: 1.28e12,
          market_cap_rank: 1,
          total_volume: 2.2e10,
          high_24h: 64000,
          low_24h: 62000,
          price_change_percentage_24h: 0.1,
          price_change_percentage_24h_in_currency: 0.2,
          price_change_percentage_1h_in_currency: 0.05,
          price_change_percentage_7d_in_currency: 5.5,
          circulating_supply: 19_000_000,
          total_supply: 21_000_000,
          max_supply: 21_000_000,
          ath: 73000,
          ath_date: '2024-03-14T00:00:00.000Z',
          atl: 67,
          atl_date: '2013-07-06T00:00:00.000Z',
          roi: null,
        },
      ]),
    );
    const coins = await makeService().coinsMarkets(
      { vsCurrency: 'usd', order: 'market_cap_desc', page: 1, perPage: 50 },
      ctx,
    );
    const coin = coins?.[0];
    expect(coin?.priceChangePercentage24h).toBe(0.2); // in-currency wins over plain
    expect(coin?.priceChangePercentage1h).toBe(0.05);
    expect(coin?.athDate).toBe('2024-03-14T00:00:00.000Z');
    expect(coin).not.toHaveProperty('roi');
  });

  it('returns null on a 404 for a category-filtered request (unrecognized slug)', async () => {
    // CoinGecko 404s on a bad category. The category path uses getJsonOrNull so
    // the tool can map null → typed unknown_category.
    mockFetchWithTimeout.mockRejectedValueOnce(
      fetchHttpError(404, '{"status":404,"error":"Not Found"}'),
    );
    const out = await makeService().coinsMarkets(
      { vsCurrency: 'usd', order: 'market_cap_desc', category: 'not-real', page: 1, perPage: 5 },
      ctx,
    );
    expect(out).toBeNull();
  });

  it('returns an empty array (not null) for a valid category paged past its last row', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse([]));
    const out = await makeService().coinsMarkets(
      { vsCurrency: 'usd', order: 'market_cap_desc', category: 'real-cat', page: 99, perPage: 50 },
      ctx,
    );
    expect(out).toEqual([]);
  });
});

describe('coinDetail — sparse payloads + 404', () => {
  it('merges platform addresses and reads market metrics in the requested currency', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        id: 'sample',
        symbol: 's',
        name: 'Sample',
        asset_platform_id: 'solana',
        market_cap_rank: 10,
        platforms: { '': '', solana: 'Old', ethereum: 'EthAddr', base: 'BaseAddr', polygon: '' },
        detail_platforms: {
          solana: { contract_address: 'AbCdEf', decimal_place: 0 },
          ethereum: { contract_address: '', decimal_place: 18 },
          polygon: { contract_address: '', decimal_place: null },
        },
        market_data: {
          current_price: { eur: 1 },
          total_volume: { usd: 5, eur: 0 },
          high_24h: { usd: 20, eur: 10 },
          low_24h: { usd: 2, eur: 1 },
        },
      }),
    );
    const out = await makeService().coinDetail('sample', 'eur', ctx);
    expect(out?.platforms).toEqual({
      assetPlatformId: 'solana',
      contracts: [
        { platform: 'solana', contractAddress: 'AbCdEf', decimalPlace: 0 },
        { platform: 'ethereum', contractAddress: 'EthAddr', decimalPlace: 18 },
        { platform: 'base', contractAddress: 'BaseAddr' },
      ],
    });
    expect(out?.market).toMatchObject({
      totalVolume: 0,
      high24h: 10,
      low24h: 1,
      marketCapRank: 10,
    });
  });

  it('returns null on HTTP 404 (unknown slug)', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      fetchHttpError(404, JSON.stringify({ error: 'coin not found' })),
    );
    const out = await makeService().coinDetail('notacoin', 'usd', ctx);
    expect(out).toBeNull();
  });

  it('preserves absence for empty links, null community, and null sentiment', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        id: 'sparse',
        symbol: 'spr',
        name: 'Sparse Coin',
        categories: ['Layer 1 (L1)', null],
        description: { en: '' },
        platforms: { '': '' },
        detail_platforms: { '': { contract_address: '', decimal_place: null } },
        links: { homepage: ['', ''], repos_url: { github: [] }, whitepaper: '' },
        community_data: {
          reddit_subscribers: null,
          facebook_likes: null,
          telegram_channel_user_count: null,
        },
        developer_data: { stars: null, forks: 12 },
        sentiment_votes_up_percentage: null,
        sentiment_votes_down_percentage: null,
        market_data: {
          current_price: { usd: 1.5 },
          ath: { usd: 9 },
          ath_date: { usd: '2021-11-10T00:00:00.000Z' },
          // atl absent entirely
          price_change_percentage_24h: -3.2,
        },
      }),
    );
    const out = await makeService().coinDetail('sparse', 'usd', ctx);
    expect(out).not.toBeNull();
    if (!out) return;

    // Categories: nulls dropped, display names kept.
    expect(out.profile.categories).toEqual(['Layer 1 (L1)']);
    expect(out.platforms).toEqual({ contracts: [] });
    // Empty description string treated as absent.
    expect(out.profile).not.toHaveProperty('description');
    // Empty homepage entries + empty repos → empty arrays, not fabricated.
    expect(out.links.homepage).toEqual([]);
    expect(out.links.repos).toEqual([]);
    expect(out.links).not.toHaveProperty('whitepaper');
    // Null community/sentiment → omitted, not zeroed.
    expect(out.community).not.toHaveProperty('redditSubscribers');
    expect(out.sentiment).not.toHaveProperty('upPercentage');
    // Developer: null stars dropped, real forks kept.
    expect(out.developer).not.toHaveProperty('stars');
    expect(out.developer.forks).toBe(12);
    // Market: currency-keyed scalars extracted; atl absent.
    expect(out.market.currentPrice).toBe(1.5);
    expect(out.market.ath).toEqual({ price: 9, date: '2021-11-10T00:00:00.000Z' });
    expect(out.market).not.toHaveProperty('atl');
    expect(out.market.priceChangePct.d24h).toBe(-3.2);
  });
});

describe('trending — drop display strings, keep numerics', () => {
  it('surfaces price float + USD 24h change, ignores formatted strings', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        coins: [
          {
            item: {
              id: 'pepe',
              name: 'Pepe',
              symbol: 'PEPE',
              market_cap_rank: 40,
              price_btc: 0.0000001,
              data: {
                price: 0.0000099,
                market_cap: '$4,000,000,000', // display string — must NOT surface
                total_volume: '$1,234,567',
                price_change_percentage_24h: { usd: -75.2, eur: -74.1 },
              },
            },
          },
        ],
        nfts: [{}, {}],
      }),
    );
    const out = await makeService().trending(ctx);
    expect(out.coins).toEqual([
      {
        id: 'pepe',
        name: 'Pepe',
        symbol: 'PEPE',
        marketCapRank: 40,
        priceUsd: 0.0000099,
        priceBtc: 0.0000001,
        priceChangePercentage24hUsd: -75.2,
      },
    ]);
    expect(out.nftCount).toBe(2);
  });
});

describe('global', () => {
  it('omits a partial sentiment index and handles an absent dominance map', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        data: { total_market_cap: { usd: 0 }, fear_and_greed_index: { value: 1 } },
      }),
    );
    expect(await makeService().global('usd', ctx)).toEqual({ totalMarketCap: 0, dominance: [] });
  });

  it('preserves all reported dominance and sentiment without fabricating absent totals', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        data: {
          total_market_cap: { usd: 0 },
          total_volume: { usd: null },
          market_cap_percentage: { BTC: 1.23456, eth: 0, usdt: null },
          ongoing_icos: 0,
          fear_and_greed_index: { value: 0, sentiment: 'extreme_fear' },
        },
      }),
    );
    expect(await makeService().global('usd', ctx)).toEqual({
      totalMarketCap: 0,
      ethDominance: 0,
      ongoingIcos: 0,
      dominance: [
        { symbol: 'BTC', percentage: 1.23456 },
        { symbol: 'eth', percentage: 0 },
      ],
      fearGreedIndex: { value: 0, sentiment: 'extreme_fear' },
    });
  });

  it('unwraps data and selects the vs_currency key', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        data: {
          active_cryptocurrencies: 17463,
          ongoing_icos: 49,
          markets: 1486,
          total_market_cap: { usd: 2.27e12, eur: 2.1e12 },
          total_volume: { usd: 9e10 },
          market_cap_percentage: { btc: 56.4, eth: 13.1 },
          market_cap_change_percentage_24h_usd: 1.2,
          volume_change_percentage_24h_usd: -3.4,
          updated_at: 1781351543,
        },
      }),
    );
    const out = await makeService().global('usd', ctx);
    expect(out.totalMarketCap).toBe(2.27e12);
    expect(out.btcDominance).toBe(56.4);
    expect(out.ethDominance).toBe(13.1);
    expect(out.marketCapChangePercentage24h).toBe(1.2);
    expect(out.volumeChangePercentage24h).toBe(-3.4);
    expect(out.updatedAtUnixSec).toBe(1781351543);
  });

  it('throws unsupported_currency rather than fabricating a 0 total for a missing key', async () => {
    // /global has no vs_currency param — an unknown code is absent from the maps,
    // not rejected upstream. A `?? 0` fallback would misreport the market as $0.
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        data: {
          total_market_cap: { usd: 2.27e12 },
          total_volume: { usd: 9e10 },
          market_cap_percentage: { btc: 56.4 },
        },
      }),
    );
    await expect(makeService().global('notacurrency', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unsupported_currency' },
    });
  });
});

describe('marketChart', () => {
  it.each(['auto', 'daily', 'hourly'] as const)(
    'forwards interval=%s on both endpoints with normalized IDs (#6/#13)',
    async (interval) => {
      const raw = {
        prices: [
          [1789516800000, 75590.24471973324],
          [1789603200000, 76146.81236783884],
        ],
        market_caps: [],
        total_volumes: [],
      };
      mockFetchWithTimeout
        .mockResolvedValueOnce(jsonResponse(raw))
        .mockResolvedValueOnce(jsonResponse(raw));
      const service = makeService();
      await service.marketChart(' Bitcoin ', ' USD ', 30, ctx, interval);
      await service.marketChartRange(' Bitcoin ', ' USD ', 1789516800, 1789603200, ctx, interval);
      for (const [url] of mockFetchWithTimeout.mock.calls) {
        const parsed = new URL(url);
        expect(parsed.pathname).toContain('/coins/bitcoin/market_chart');
        expect(parsed.searchParams.get('vs_currency')).toBe('usd');
        expect(parsed.searchParams.get('interval')).toBe(interval === 'auto' ? null : interval);
      }
    },
  );
  it('maps point pairs to {t, value} and returns null on 404', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        prices: [
          [1700000000000, 100],
          [1700003600000, 110],
        ],
        market_caps: [[1700000000000, 2000]],
        total_volumes: [[1700000000000, 50]],
      }),
    );
    const out = await makeService().marketChart('bitcoin', 'usd', 7, ctx);
    expect(out?.prices).toEqual([
      { t: 1700000000000, value: 100 },
      { t: 1700003600000, value: 110 },
    ]);
    expect(out?.volumes).toEqual([{ t: 1700000000000, value: 50 }]);

    mockFetchWithTimeout.mockRejectedValueOnce(fetchHttpError(404));
    expect(await makeService().marketChart('nope', 'usd', 7, ctx)).toBeNull();
  });
});

/**
 * HTTP error classification is tested at the single-attempt api-client layer so
 * the service's real exponential backoff (multi-second sleeps) doesn't run.
 */
describe('api-client HTTP error classification', () => {
  const client = () => new CoinGeckoApiClient({ timeoutMs: 5000 });

  it('matches malformed JSON to its declared transient contract (#2)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response('broken-json'));
    const error = await client()
      .getJson('op', '/global', undefined, undefined)
      .catch((e) => e);
    const contract = COINGECKO_SERVICE_ERRORS.find((entry) => entry.reason === 'invalid_response');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('invalid_response');
    expect(error.data.recovery.hint).toBe(contract?.recovery);
    expect(contract?.retryable).toBe(true);
    expect(defaultIsTransient(error)).toBe(true);
    expect(contract?.code).toBe(error.code);
  });

  it('maps 429 to a retryable RateLimited error with the rate_limited reason', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      fetchHttpError(
        429,
        JSON.stringify({ status: { error_code: 429, error_message: 'rate limit' } }),
      ),
    );
    await expect(client().getJson('op', '/global', undefined, undefined)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited' },
    });
  });

  it('preserves the upstream body and code while attaching reason + recovery hint', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(fetchHttpError(503, 'gateway down'));
    await expect(client().getJson('op', '/global', undefined, undefined)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreachable',
        responseBody: 'gateway down',
        recovery: { hint: expect.stringContaining('Retry') },
      },
    });
  });

  it('attaches the Demo header only when an API key is configured', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const keyed = new CoinGeckoApiClient({ timeoutMs: 5000, apiKey: 'demo-123' });
    await keyed.getJson('op', '/ping', undefined, undefined);
    const headers = mockFetchWithTimeout.mock.calls[0]?.[3]?.headers as Record<string, string>;
    expect(headers['x-cg-demo-api-key']).toBe('demo-123');

    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await client().getJson('op', '/ping', undefined, undefined);
    const headers2 = mockFetchWithTimeout.mock.calls[1]?.[3]?.headers as Record<string, string>;
    expect(headers2).not.toHaveProperty('x-cg-demo-api-key');
  });

  it('classifies a non-JSON 200 body as a transient ServiceUnavailable', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html>throttled</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(client().getJson('op', '/global', undefined, undefined)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('getJsonOrNull returns null on 404 but throws (enriched) on 500', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(fetchHttpError(404));
    expect(await client().getJsonOrNull('op', '/coins/x', undefined, undefined)).toBeNull();

    mockFetchWithTimeout.mockRejectedValueOnce(fetchHttpError(500, 'boom'));
    await expect(
      client().getJsonOrNull('op', '/coins/x', undefined, undefined),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreachable' },
    });
  });
});

describe('categoriesList', () => {
  it('reads market categories in upstream order and preserves sparse fields and zero', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'first',
          name: 'First',
          market_cap: 0,
          market_cap_change_24h: 0,
          volume_24h: 0,
          top_3_coins_id: ['token'],
          updated_at: '2026-11-20T00:00:00Z',
        },
        { id: 'second', name: 'Second', market_cap: null, top_3_coins_id: [], updated_at: null },
        { id: 'third', name: 'Third' },
      ]),
    );
    expect(await makeService().categoriesMarket('market_cap_change_24h_asc', ctx)).toEqual([
      {
        categoryId: 'first',
        name: 'First',
        marketCap: 0,
        marketCapChange24hPct: 0,
        volume24h: 0,
        topCoinIds: ['token'],
        updatedAt: '2026-11-20T00:00:00Z',
      },
      { categoryId: 'second', name: 'Second', topCoinIds: [] },
      { categoryId: 'third', name: 'Third' },
    ]);
    const url = new URL(mockFetchWithTimeout.mock.calls[0]?.[0]);
    expect(url.pathname).toBe('/api/v3/coins/categories');
    expect(url.searchParams.get('order')).toBe('market_cap_change_24h_asc');
  });

  it('maps category_id + name', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([
        { category_id: 'layer-1', name: 'Layer 1 (L1)' },
        { category_id: 'gaming', name: 'Gaming (GameFi)' },
      ]),
    );
    const out = await makeService().categoriesList(ctx);
    expect(out).toEqual([
      { categoryId: 'layer-1', name: 'Layer 1 (L1)' },
      { categoryId: 'gaming', name: 'Gaming (GameFi)' },
    ]);
  });
});
