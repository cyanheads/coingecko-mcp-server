/**
 * @fileoverview Domain types for the CoinGecko REST API v3 service. Raw types
 * mirror probe-verified upstream response shapes (see docs/api-probe-notes.md);
 * normalized domain types are what the service hands tools. Upstream is sparse —
 * most nested fields are optional/nullable and are preserved as "unknown" rather
 * than fabricated when absent.
 * @module src/services/coingecko/types
 */

/** Keyless and Demo-tier share this base. (Pro switches the root — out of scope.) */
export const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

/** Attribution string required by CoinGecko's terms of use. */
export const COINGECKO_ATTRIBUTION = 'Data provided by CoinGecko';

// ─────────────────────────────────────────────────────────────────────────────
// Raw upstream shapes (probe-verified)
// ─────────────────────────────────────────────────────────────────────────────

/** `/search` → `coins[]` entry. Symbols are NOT unique across coins. */
export interface RawSearchCoin {
  api_symbol?: string;
  id: string;
  large?: string;
  market_cap_rank?: number | null;
  name: string;
  symbol: string;
  thumb?: string;
}

export interface RawSearchResponse {
  categories?: unknown[];
  coins?: RawSearchCoin[];
  exchanges?: unknown[];
  nfts?: unknown[];
}

/**
 * `/simple/price` → flat per-currency-suffixed keys. A given coin maps to a dict
 * whose keys are `<currency>`, `<currency>_market_cap`, `<currency>_24h_vol`,
 * `<currency>_24h_change`, plus a top-level `last_updated_at` (Unix SECONDS).
 * A bad slug is omitted entirely (200 `{}`); a bad currency drops its key.
 */
export type RawSimplePrice = Record<string, Record<string, number>>;

/** `/coins/markets` → array of flat objects. */
export interface RawMarketCoin {
  ath?: number | null;
  ath_change_percentage?: number | null;
  ath_date?: string | null;
  atl?: number | null;
  atl_change_percentage?: number | null;
  atl_date?: string | null;
  circulating_supply?: number | null;
  current_price?: number | null;
  fully_diluted_valuation?: number | null;
  high_24h?: number | null;
  id: string;
  image?: string | null;
  last_updated?: string | null;
  low_24h?: number | null;
  market_cap?: number | null;
  market_cap_change_24h?: number | null;
  market_cap_change_percentage_24h?: number | null;
  market_cap_rank?: number | null;
  max_supply?: number | null;
  name: string;
  price_change_24h?: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  roi?: unknown;
  symbol: string;
  total_supply?: number | null;
  total_volume?: number | null;
}

/** `/coins/{id}` (large). Only the fields the tool surfaces are typed strictly. */
export interface RawCoinDetail {
  asset_platform_id?: string | null;
  categories?: (string | null)[];
  community_data?: RawCommunityData;
  country_origin?: string | null;
  description?: { en?: string } & Record<string, string | undefined>;
  developer_data?: RawDeveloperData;
  genesis_date?: string | null;
  hashing_algorithm?: string | null;
  id: string;
  last_updated?: string;
  links?: RawCoinLinks;
  market_cap_rank?: number | null;
  market_data?: RawCoinMarketData;
  name: string;
  sentiment_votes_down_percentage?: number | null;
  sentiment_votes_up_percentage?: number | null;
  symbol: string;
  web_slug?: string;
}

export interface RawCoinLinks {
  announcement_url?: string[];
  blockchain_site?: string[];
  chat_url?: string[];
  facebook_username?: string | null;
  homepage?: string[];
  official_forum_url?: string[];
  repos_url?: { github?: string[]; bitbucket?: string[] };
  snapshot_url?: string | null;
  subreddit_url?: string | null;
  telegram_channel_identifier?: string | null;
  twitter_screen_name?: string | null;
  whitepaper?: string | null;
}

/** Nested per-currency maps. `current_price` etc. are `{ usd: n, eur: n, ... }`. */
export interface RawCoinMarketData {
  ath?: Record<string, number | null>;
  ath_date?: Record<string, string | null>;
  atl?: Record<string, number | null>;
  atl_date?: Record<string, string | null>;
  circulating_supply?: number | null;
  current_price?: Record<string, number | null>;
  fully_diluted_valuation?: Record<string, number | null>;
  high_24h?: Record<string, number | null>;
  low_24h?: Record<string, number | null>;
  market_cap?: Record<string, number | null>;
  max_supply?: number | null;
  price_change_percentage_1y?: number | null;
  price_change_percentage_7d?: number | null;
  price_change_percentage_14d?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_30d?: number | null;
  price_change_percentage_60d?: number | null;
  price_change_percentage_200d?: number | null;
  total_supply?: number | null;
  total_volume?: Record<string, number | null>;
}

export interface RawCommunityData {
  facebook_likes?: number | null;
  reddit_accounts_active_48h?: number | null;
  reddit_average_comments_48h?: number | null;
  reddit_average_posts_48h?: number | null;
  reddit_subscribers?: number | null;
  telegram_channel_user_count?: number | null;
}

export interface RawDeveloperData {
  closed_issues?: number | null;
  commit_count_4_weeks?: number | null;
  forks?: number | null;
  pull_request_contributors?: number | null;
  pull_requests_merged?: number | null;
  stars?: number | null;
  subscribers?: number | null;
  total_issues?: number | null;
}

/** `/search/trending` → heavily nested. */
export interface RawTrendingResponse {
  categories?: unknown[];
  coins?: { item: RawTrendingItem }[];
  nfts?: unknown[];
}

export interface RawTrendingItem {
  coin_id?: number;
  data?: {
    /** Float — the only trustworthy numeric field. */
    price?: number;
    price_btc?: string;
    /** Pre-formatted display string (e.g. "$92,219,216") — NOT numeric. */
    market_cap?: string;
    total_volume?: string;
    total_volume_btc?: string;
    market_cap_btc?: string;
    /** Flat dict keyed by currency code: { usd: number, eur: number, ... }. */
    price_change_percentage_24h?: Record<string, number>;
  };
  id: string;
  large?: string;
  market_cap_rank?: number | null;
  name: string;
  price_btc?: number;
  score?: number;
  slug?: string;
  small?: string;
  symbol: string;
  thumb?: string;
}

/** `/global` → wrapped in `data`. */
export interface RawGlobalResponse {
  data?: RawGlobalData;
}

export interface RawGlobalData {
  active_cryptocurrencies?: number;
  ended_icos?: number;
  /** Always USD-denominated regardless of vs_currency (field name embeds _usd). */
  market_cap_change_percentage_24h_usd?: number;
  market_cap_percentage?: Record<string, number>;
  markets?: number;
  ongoing_icos?: number;
  total_market_cap?: Record<string, number>;
  total_volume?: Record<string, number>;
  upcoming_icos?: number;
  updated_at?: number;
  volume_change_percentage_24h_usd?: number;
}

/** `/coins/{id}/market_chart` — timestamps are MILLISECONDS. */
export interface RawMarketChart {
  market_caps?: [number, number][];
  prices?: [number, number][];
  total_volumes?: [number, number][];
}

/** `/coins/categories/list` → array. Key is `category_id` (slug consumed by markets). */
export interface RawCategory {
  category_id: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized domain types (what the service returns to tools)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchCoin {
  id: string;
  marketCapRank?: number;
  name: string;
  symbol: string;
  thumb?: string;
}

/** Per-currency stats for one coin from /simple/price. */
export interface PriceEntry {
  change24h?: number;
  marketCap?: number;
  price: number;
  vol24h?: number;
}

export interface SimplePriceResult {
  /** Unix SECONDS. */
  lastUpdatedAt?: number;
  /** Requested ids that were entirely absent from the response. */
  missing: string[];
  /** Flattened: one row per (id, currency) that returned a price. */
  rows: {
    id: string;
    currency: string;
    price: number;
    marketCap?: number;
    vol24h?: number;
    change24h?: number;
  }[];
}

export interface MarketCoin {
  ath?: number;
  athDate?: string;
  atl?: number;
  atlDate?: string;
  circulatingSupply?: number;
  currentPrice?: number;
  high24h?: number;
  id: string;
  low24h?: number;
  marketCap?: number;
  marketCapRank?: number;
  maxSupply?: number;
  name: string;
  priceChangePercentage1h?: number;
  priceChangePercentage7d?: number;
  priceChangePercentage24h?: number;
  symbol: string;
  totalSupply?: number;
  totalVolume?: number;
}

export interface CoinDetail {
  community: {
    redditSubscribers?: number;
  };
  developer: {
    stars?: number;
    forks?: number;
    commits4w?: number;
    totalIssues?: number;
    closedIssues?: number;
  };
  id: string;
  links: {
    homepage: string[];
    whitepaper?: string;
    repos: string[];
    subreddit?: string;
    twitter?: string;
    telegram?: string;
  };
  market: {
    currentPrice?: number;
    marketCap?: number;
    fullyDilutedValuation?: number;
    circulatingSupply?: number;
    totalSupply?: number;
    maxSupply?: number;
    ath?: { price: number; date?: string };
    atl?: { price: number; date?: string };
    priceChangePct: {
      d24h?: number;
      d7d?: number;
      d30d?: number;
      d1y?: number;
    };
  };
  name: string;
  profile: {
    description?: string;
    categories: string[];
    genesisDate?: string;
    hashingAlgorithm?: string;
    countryOrigin?: string;
  };
  sentiment: {
    upPercentage?: number;
    downPercentage?: number;
  };
  symbol: string;
}

export interface TrendingCoin {
  id: string;
  marketCapRank?: number;
  name: string;
  priceBtc?: number;
  priceChangePercentage24hUsd?: number;
  priceUsd?: number;
  symbol: string;
}

export interface TrendingResult {
  coins: TrendingCoin[];
  nftCount: number;
}

export interface GlobalMarket {
  activeCryptocurrencies: number;
  btcDominance: number;
  ethDominance: number;
  marketCapChangePercentage24h: number;
  markets: number;
  ongoingIcos: number;
  totalMarketCap: number;
  totalVolume24h: number;
  updatedAtUnixSec: number;
  volumeChangePercentage24h: number;
}

/** One chart point. `t` is MILLISECONDS (unlike /simple/price seconds). */
export interface ChartPoint {
  t: number;
  value: number;
}

export type ChartGranularity = 'minutely' | 'hourly' | 'daily';

export interface MarketChartResult {
  marketCaps: ChartPoint[];
  prices: ChartPoint[];
  volumes: ChartPoint[];
}

export interface Category {
  categoryId: string;
  name: string;
}
