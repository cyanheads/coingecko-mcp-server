/**
 * @fileoverview CoinGecko REST API v3 service. One method per endpoint the tools
 * need; each wraps the full fetch+parse pipeline in `withRetry` (transient codes
 * — 429/5xx/timeout — retried with calibrated backoff). Normalizes probe-verified
 * raw shapes into honest domain types, preserving upstream absence rather than
 * fabricating values. Init/accessor pattern; initialized from `setup()`.
 * @module src/services/coingecko/coingecko-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { CoinGeckoApiClient } from './api-client.js';
import type {
  Category,
  CategoryMarket,
  CategoryMarketOrder,
  CoinDetail,
  GlobalMarket,
  MarketChartResult,
  MarketCoin,
  RawCategory,
  RawCategoryMarket,
  RawCoinDetail,
  RawGlobalResponse,
  RawMarketChart,
  RawMarketCoin,
  RawSearchResponse,
  RawSimplePrice,
  RawTrendingResponse,
  SearchCoin,
  SimplePriceResult,
  TrendingResult,
} from './types.js';

/** Rate-limited upstream → back off on the longer end (per the design's resilience table). */
const BASE_DELAY_MS = 1500;
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const COIN_DEADLINE_MS = 50_000;

/** Normalize CoinGecko CSV selectors in first-seen order before applying a limit. */
export function normalizeCsvList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase()))
        .filter(Boolean),
    ),
  ];
}

/** Reads `vs_currency` from a per-currency map, treating null as absent. */
function pickCurrency(
  map: Record<string, number | null> | null | undefined,
  currency: string,
): number | undefined {
  const v = map?.[currency];
  return typeof v === 'number' ? v : undefined;
}

/** Legacy scalar changes are USD-only, and only replace a wholly absent map. */
function pickChange(
  map: Record<string, number | null> | null | undefined,
  usdScalar: number | null | undefined,
  currency: string,
): number | undefined {
  return map === undefined && currency === 'usd' ? num(usdScalar) : pickCurrency(map, currency);
}

function pickDate(
  map: Record<string, string | null> | undefined,
  currency: string,
): string | undefined {
  const v = map?.[currency];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Numeric-or-undefined coercion: null/undefined collapse to undefined. */
function num(v: number | null | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toPoints(pairs: [number, number][] | undefined): { t: number; value: number }[] {
  return (pairs ?? []).map(([t, value]) => ({ t, value }));
}

/**
 * Strip keys whose value is `undefined`, returning a type whose optional
 * properties are exact (no `| undefined`) — the honest "omit absent" shape under
 * `exactOptionalPropertyTypes`. Lets normalizers build flat records with
 * undefined-able values and drop the absent ones in one pass.
 */
function omitUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** Service facade over the CoinGecko v3 REST API. */
export class CoinGeckoService {
  constructor(private readonly client: CoinGeckoApiClient) {}

  private retry<T>(operation: string, ctx: Context, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      operation,
      baseDelayMs: BASE_DELAY_MS,
      maxRetries: MAX_RETRIES,
      signal: ctx.signal,
    });
  }

  /** `/search` — resolve a name/ticker to ranked slug candidates. */
  async search(query: string, ctx: Context): Promise<SearchCoin[]> {
    const raw = await this.retry('coingecko.search', ctx, () =>
      this.client.getJson<RawSearchResponse>('coingecko.search', '/search', { query }, ctx.signal),
    );
    return (raw.coins ?? []).map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      ...omitUndefined({
        marketCapRank: typeof c.market_cap_rank === 'number' ? c.market_cap_rank : undefined,
        thumb: str(c.thumb),
      }),
    }));
  }

  /** Resolve a contract address on one asset platform, preserving address case. */
  async searchByContract(
    platform: string,
    contractAddress: string,
    ctx: Context,
  ): Promise<SearchCoin | null> {
    const normalizedPlatform = platform.trim().toLowerCase();
    const address = contractAddress.trim();
    if ([normalizedPlatform, address].some((segment) => segment === '.' || segment === '..')) {
      throw invalidParams('Supply a platform ID and contract address without URL dot segments.');
    }
    const raw = await this.retry('coingecko.searchByContract', ctx, () =>
      this.client.getJsonOrNull<RawCoinDetail>(
        'coingecko.searchByContract',
        `/coins/${encodeURIComponent(normalizedPlatform)}/contract/${encodeURIComponent(address)}`,
        {
          localization: false,
          tickers: false,
          market_data: false,
          community_data: false,
          developer_data: false,
          sparkline: false,
        },
        ctx.signal,
      ),
    );
    if (!raw) return null;
    return {
      id: raw.id,
      symbol: raw.symbol,
      name: raw.name,
      ...omitUndefined({ marketCapRank: num(raw.market_cap_rank) }),
    };
  }

  /**
   * `/simple/price` — batch current price for ids × currencies. Diffs requested
   * ids against returned keys to populate `missing` (silent-miss detection): a
   * bad slug is omitted entirely upstream, so absence here is the only signal.
   */
  async simplePrice(
    ids: string[],
    vsCurrencies: string[],
    ctx: Context,
  ): Promise<SimplePriceResult> {
    ids = normalizeCsvList(ids);
    vsCurrencies = normalizeCsvList(vsCurrencies);
    if (!ids.length || !vsCurrencies.length) {
      throw invalidParams('Supply at least one coin ID and one quote currency.');
    }
    const raw = await this.retry('coingecko.simplePrice', ctx, () =>
      this.client.getJson<RawSimplePrice>(
        'coingecko.simplePrice',
        '/simple/price',
        {
          ids: ids.join(','),
          vs_currencies: vsCurrencies.join(','),
          include_market_cap: true,
          include_24hr_vol: true,
          include_24hr_change: true,
          include_last_updated_at: true,
        },
        ctx.signal,
      ),
    );

    const rows: SimplePriceResult['rows'] = [];
    const returnedIds = new Set<string>();
    let lastUpdatedAt: number | undefined;

    for (const [id, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object') continue;
      returnedIds.add(id);
      const timestamp = num(entry.last_updated_at);
      for (const currency of vsCurrencies) {
        const price = entry[currency];
        if (typeof price !== 'number') continue; // bad currency drops its key silently
        if (timestamp !== undefined) {
          lastUpdatedAt = Math.min(lastUpdatedAt ?? timestamp, timestamp);
        }
        rows.push({
          id,
          currency,
          price,
          ...omitUndefined({
            lastUpdatedAtUnixSec: timestamp,
            marketCap: num(entry[`${currency}_market_cap`]),
            vol24h: num(entry[`${currency}_24h_vol`]),
            change24h: num(entry[`${currency}_24h_change`]),
          }),
        });
      }
    }

    const missing = ids.filter((id) => !returnedIds.has(id));
    return { rows, missing, ...(lastUpdatedAt !== undefined && { lastUpdatedAt }) };
  }

  /**
   * `/coins/markets` — ranked market table (one page). Returns `null` only when a
   * `category` was supplied and upstream answered 404 (an unrecognized category
   * slug — CoinGecko 404s on a bad category rather than returning an empty array),
   * so the tool can throw a typed `unknown_category`. Without a category, a 404 is
   * not expected and bubbles as a normal error.
   */
  async coinsMarkets(
    params: {
      vsCurrency: string;
      ids?: string[];
      order: string;
      category?: string;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<MarketCoin[] | null> {
    const ids = params.ids && normalizeCsvList(params.ids);
    if (ids?.length === 0) throw invalidParams('Supply at least one coin ID.');
    const query = {
      vs_currency: params.vsCurrency.trim().toLowerCase(),
      ...(ids && { ids: ids.join(',') }),
      order: params.order,
      ...(params.category && { category: params.category }),
      page: params.page,
      per_page: params.perPage,
      price_change_percentage: '1h,24h,7d',
      sparkline: false,
    };
    const raw = await this.retry('coingecko.coinsMarkets', ctx, () =>
      params.category
        ? this.client.getJsonOrNull<RawMarketCoin[]>(
            'coingecko.coinsMarkets',
            '/coins/markets',
            query,
            ctx.signal,
          )
        : this.client.getJson<RawMarketCoin[]>(
            'coingecko.coinsMarkets',
            '/coins/markets',
            query,
            ctx.signal,
          ),
    );
    if (raw === null) return null;
    return raw.map(
      (c): MarketCoin => ({
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        ...omitUndefined({
          currentPrice: num(c.current_price),
          marketCap: num(c.market_cap),
          marketCapRank: num(c.market_cap_rank),
          totalVolume: num(c.total_volume),
          high24h: num(c.high_24h),
          low24h: num(c.low_24h),
          priceChangePercentage24h: num(
            c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
          ),
          priceChangePercentage1h: num(c.price_change_percentage_1h_in_currency),
          priceChangePercentage7d: num(c.price_change_percentage_7d_in_currency),
          circulatingSupply: num(c.circulating_supply),
          totalSupply: num(c.total_supply),
          maxSupply: num(c.max_supply),
          ath: num(c.ath),
          athDate: str(c.ath_date),
          atl: num(c.atl),
          atlDate: str(c.atl_date),
        }),
      }),
    );
  }

  /**
   * `/coins/{id}` — deep profile. Returns `null` on 404 (unknown slug) so the
   * tool can throw a typed `coin_not_found`. `currency` selects the scalar to
   * pull from the per-currency `market_data` maps.
   */
  async coinDetail(
    id: string,
    currency: string,
    ctx: Context,
    marketSelected = true,
  ): Promise<CoinDetail | null> {
    id = id.trim().toLowerCase();
    currency = currency.trim().toLowerCase();
    const raw = await withRetry(
      async ({ signal }) => {
        const boundedCtx = { ...ctx, signal };
        const record = await this.retry('coingecko.coinDetail', boundedCtx, () =>
          this.client.getJsonOrNull<RawCoinDetail>(
            'coingecko.coinDetail',
            `/coins/${encodeURIComponent(id)}`,
            {
              localization: false,
              tickers: false,
              market_data: true,
              community_data: true,
              developer_data: true,
              sparkline: false,
            },
            signal,
          ),
        );
        if (
          record &&
          marketSelected &&
          !Object.hasOwn(record.market_data?.current_price ?? {}, currency)
        ) {
          const supported = await this.retry('coingecko.supportedCurrencies', boundedCtx, () =>
            this.client.getJson<string[]>(
              'coingecko.supportedCurrencies',
              '/simple/supported_vs_currencies',
              undefined,
              signal,
            ),
          );
          if (!supported.includes(currency)) {
            throw notFound(`CoinGecko does not support quote currency "${currency}".`, {
              reason: 'unsupported_currency',
              currency,
              recovery: {
                hint: 'Use a supported currency code such as "usd", "eur", or "btc" for market data.',
              },
              retryable: false,
            });
          }
        }
        return record;
      },
      {
        operation: 'coingecko.coinDetail',
        maxRetries: 0,
        // Deadline envelope only: retain the inner request's retries and error metadata.
        isTransient: () => false,
        signal: ctx.signal,
        deadlineMs: COIN_DEADLINE_MS,
      },
    );
    if (!raw) return null;

    const md = raw.market_data;
    const links = raw.links;
    const dev = raw.developer_data;
    const comm = raw.community_data;

    const categories = (raw.categories ?? []).filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    );
    const homepage = (links?.homepage ?? []).filter((u) => typeof u === 'string' && u.length > 0);
    const repos = [
      ...(links?.repos_url?.github ?? []),
      ...(links?.repos_url?.bitbucket ?? []),
    ].filter((u) => typeof u === 'string' && u.length > 0);

    const athPrice = pickCurrency(md?.ath, currency);
    const atlPrice = pickCurrency(md?.atl, currency);
    const athDate = pickDate(md?.ath_date, currency);
    const atlDate = pickDate(md?.atl_date, currency);
    const platforms = raw.platforms ?? {};
    const detailPlatforms = raw.detail_platforms ?? {};
    const contracts: CoinDetail['platforms']['contracts'] = [];
    for (const platform of new Set([...Object.keys(platforms), ...Object.keys(detailPlatforms)])) {
      if (!platform.trim()) continue;
      const detail = detailPlatforms[platform];
      const contractAddress = detail?.contract_address?.trim() || platforms[platform]?.trim();
      if (!contractAddress) continue;
      contracts.push({
        platform,
        contractAddress,
        ...omitUndefined({ decimalPlace: num(detail?.decimal_place) }),
      });
    }

    return {
      id: raw.id,
      symbol: raw.symbol,
      name: raw.name,
      platforms: {
        contracts,
        ...omitUndefined({ assetPlatformId: str(raw.asset_platform_id) }),
      },
      profile: {
        categories,
        ...omitUndefined({
          description: str(raw.description?.en),
          genesisDate: str(raw.genesis_date),
          hashingAlgorithm: str(raw.hashing_algorithm),
          countryOrigin: str(raw.country_origin),
        }),
      },
      market: {
        priceChangePct: omitUndefined({
          d24h: pickChange(
            md?.price_change_percentage_24h_in_currency,
            md?.price_change_percentage_24h,
            currency,
          ),
          d7d: pickChange(
            md?.price_change_percentage_7d_in_currency,
            md?.price_change_percentage_7d,
            currency,
          ),
          d30d: pickChange(
            md?.price_change_percentage_30d_in_currency,
            md?.price_change_percentage_30d,
            currency,
          ),
          d1y: pickChange(
            md?.price_change_percentage_1y_in_currency,
            md?.price_change_percentage_1y,
            currency,
          ),
        }),
        ...omitUndefined({
          currentPrice: pickCurrency(md?.current_price, currency),
          marketCap: pickCurrency(md?.market_cap, currency),
          marketCapRank: num(raw.market_cap_rank),
          totalVolume: pickCurrency(md?.total_volume, currency),
          high24h: pickCurrency(md?.high_24h, currency),
          low24h: pickCurrency(md?.low_24h, currency),
          fullyDilutedValuation: pickCurrency(md?.fully_diluted_valuation, currency),
          circulatingSupply: num(md?.circulating_supply),
          totalSupply: num(md?.total_supply),
          maxSupply: num(md?.max_supply),
          ath:
            athPrice !== undefined
              ? { price: athPrice, ...omitUndefined({ date: athDate }) }
              : undefined,
          atl:
            atlPrice !== undefined
              ? { price: atlPrice, ...omitUndefined({ date: atlDate }) }
              : undefined,
        }),
      },
      links: {
        homepage,
        repos,
        ...omitUndefined({
          whitepaper: str(links?.whitepaper),
          subreddit: str(links?.subreddit_url),
          twitter: str(links?.twitter_screen_name),
          telegram: str(links?.telegram_channel_identifier),
        }),
      },
      developer: omitUndefined({
        stars: num(dev?.stars),
        forks: num(dev?.forks),
        commits4w: num(dev?.commit_count_4_weeks),
        totalIssues: num(dev?.total_issues),
        closedIssues: num(dev?.closed_issues),
      }),
      community: omitUndefined({
        redditSubscribers: num(comm?.reddit_subscribers),
      }),
      sentiment: omitUndefined({
        upPercentage: num(raw.sentiment_votes_up_percentage),
        downPercentage: num(raw.sentiment_votes_down_percentage),
      }),
    };
  }

  /**
   * `/coins/{id}/market_chart` (recent) or `/market_chart/range` (explicit). Both
   * return `null` on 404. Timestamps are MILLISECONDS.
   */
  async marketChart(
    id: string,
    vsCurrency: string,
    days: number | 'max',
    ctx: Context,
    interval: 'auto' | 'daily' | 'hourly' = 'auto',
  ): Promise<MarketChartResult | null> {
    id = id.trim().toLowerCase();
    vsCurrency = vsCurrency.trim().toLowerCase();
    const raw = await this.retry('coingecko.marketChart', ctx, () =>
      this.client.getJsonOrNull<RawMarketChart>(
        'coingecko.marketChart',
        `/coins/${encodeURIComponent(id)}/market_chart`,
        {
          vs_currency: vsCurrency,
          days: String(days === 'max' ? 365 : days),
          ...(interval !== 'auto' && { interval }),
        },
        ctx.signal,
      ),
    );
    return raw ? this.toChart(raw) : null;
  }

  async marketChartRange(
    id: string,
    vsCurrency: string,
    from: number,
    to: number,
    ctx: Context,
    interval: 'auto' | 'daily' | 'hourly' = 'auto',
  ): Promise<MarketChartResult | null> {
    id = id.trim().toLowerCase();
    vsCurrency = vsCurrency.trim().toLowerCase();
    const raw = await this.retry('coingecko.marketChartRange', ctx, () =>
      this.client.getJsonOrNull<RawMarketChart>(
        'coingecko.marketChartRange',
        `/coins/${encodeURIComponent(id)}/market_chart/range`,
        { vs_currency: vsCurrency, from, to, ...(interval !== 'auto' && { interval }) },
        ctx.signal,
      ),
    );
    return raw ? this.toChart(raw) : null;
  }

  private toChart(raw: RawMarketChart): MarketChartResult {
    return {
      prices: toPoints(raw.prices),
      marketCaps: toPoints(raw.market_caps),
      volumes: toPoints(raw.total_volumes),
    };
  }

  /** `/search/trending` — surfaces only trustworthy numerics (price float + USD 24h change). */
  async trending(ctx: Context): Promise<TrendingResult> {
    const raw = await this.retry('coingecko.trending', ctx, () =>
      this.client.getJson<RawTrendingResponse>(
        'coingecko.trending',
        '/search/trending',
        undefined,
        ctx.signal,
      ),
    );
    const coins = (raw.coins ?? []).map(({ item }) => ({
      id: item.id,
      name: item.name,
      symbol: item.symbol,
      ...omitUndefined({
        marketCapRank: typeof item.market_cap_rank === 'number' ? item.market_cap_rank : undefined,
        priceUsd: typeof item.data?.price === 'number' ? item.data.price : undefined,
        priceBtc: typeof item.price_btc === 'number' ? item.price_btc : undefined,
        priceChangePercentage24hUsd:
          typeof item.data?.price_change_percentage_24h?.usd === 'number'
            ? item.data.price_change_percentage_24h.usd
            : undefined,
      }),
    }));
    return { coins, nftCount: (raw.nfts ?? []).length };
  }

  /**
   * `/global` — macro snapshot. `currency` selects the dict key for cap/volume.
   * Unlike most endpoints, `/global` has no `vs_currency` param — it returns every
   * supported currency and the key is selected client-side, so an unsupported
   * currency is NOT rejected upstream. Throws a typed `unsupported_currency`
   * (NotFound) when the requested key is absent rather than fabricating a
   * `0` total (which would misreport the entire market as worthless).
   */
  async global(currency: string, ctx: Context): Promise<GlobalMarket> {
    currency = currency.trim().toLowerCase();
    const raw = await this.retry('coingecko.global', ctx, () =>
      this.client.getJson<RawGlobalResponse>('coingecko.global', '/global', undefined, ctx.signal),
    );
    const d = raw.data ?? {};
    const totalMarketCap = d.total_market_cap?.[currency];
    if (typeof totalMarketCap !== 'number') {
      throw notFound(`CoinGecko does not report global totals in "${currency}".`, {
        reason: 'unsupported_currency',
        currency,
        recovery: {
          hint: 'Use a supported currency code (e.g. "usd", "eur", "btc"). /global has no vs_currency validation, so an unknown code yields no totals.',
        },
      });
    }
    const dominance = Object.entries(d.market_cap_percentage ?? {}).flatMap(
      ([symbol, percentage]) => (typeof percentage === 'number' ? [{ symbol, percentage }] : []),
    );
    const value = num(d.fear_and_greed_index?.value);
    const sentiment = str(d.fear_and_greed_index?.sentiment);
    return {
      totalMarketCap,
      dominance,
      ...omitUndefined({
        totalVolume24h: pickCurrency(d.total_volume, currency),
        btcDominance: num(d.market_cap_percentage?.btc),
        ethDominance: num(d.market_cap_percentage?.eth),
        activeCryptocurrencies: num(d.active_cryptocurrencies),
        markets: num(d.markets),
        ongoingIcos: num(d.ongoing_icos),
        marketCapChangePercentage24h: num(d.market_cap_change_percentage_24h_usd),
        volumeChangePercentage24h: num(d.volume_change_percentage_24h_usd),
        updatedAtUnixSec: num(d.updated_at),
        fearGreedIndex:
          value !== undefined && sentiment !== undefined ? { value, sentiment } : undefined,
      }),
    };
  }

  /** `/coins/categories/list` — full bounded list (the tool filters locally). */
  async categoriesList(ctx: Context): Promise<Category[]> {
    const raw = await this.retry('coingecko.categoriesList', ctx, () =>
      this.client.getJson<RawCategory[]>(
        'coingecko.categoriesList',
        '/coins/categories/list',
        undefined,
        ctx.signal,
      ),
    );
    return raw.map((c) => ({ categoryId: c.category_id, name: c.name }));
  }

  /** `/coins/categories` — aggregate category metrics in upstream order. */
  async categoriesMarket(order: CategoryMarketOrder, ctx: Context): Promise<CategoryMarket[]> {
    const raw = await this.retry('coingecko.categoriesMarket', ctx, () =>
      this.client.getJson<RawCategoryMarket[]>(
        'coingecko.categoriesMarket',
        '/coins/categories',
        { order },
        ctx.signal,
      ),
    );
    return raw.map((category) => ({
      categoryId: category.id,
      name: category.name,
      ...omitUndefined({
        marketCap: num(category.market_cap),
        marketCapChange24hPct: num(category.market_cap_change_24h),
        volume24h: num(category.volume_24h),
        updatedAt: str(category.updated_at),
        topCoinIds: category.top_3_coins_id ?? undefined,
      }),
    }));
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: CoinGeckoService | undefined;

/** Initialize the CoinGecko service. Call from `setup()` in createApp. */
export function initCoinGeckoService(): void {
  const config = getServerConfig();
  const client = new CoinGeckoApiClient({
    timeoutMs: TIMEOUT_MS,
    ...(config.apiKey && { apiKey: config.apiKey }),
  });
  _service = new CoinGeckoService(client);
  logger.info(
    'CoinGecko service initialized.',
    requestContextService.createRequestContext({
      operation: 'CoinGeckoInit',
      additionalContext: { hasApiKey: !!config.apiKey, timeoutMs: TIMEOUT_MS },
    }),
  );
}

/** Get the initialized CoinGecko service. Throws if not initialized. */
export function getCoinGeckoService(): CoinGeckoService {
  if (!_service) {
    throw new Error('CoinGecko service not initialized — call initCoinGeckoService() in setup().');
  }
  return _service;
}
