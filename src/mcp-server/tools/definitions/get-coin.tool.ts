/**
 * @fileoverview coingecko_get_coin — deep profile for a single coin (description,
 * categories, links, full market data, developer activity, community stats,
 * sentiment). The full record is large; `sections` trims it to what's needed.
 * @module src/mcp-server/tools/definitions/get-coin.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCoinGeckoService } from '@/services/coingecko/coingecko-service.js';
import { COINGECKO_SERVICE_ERRORS } from '@/services/coingecko/error-contracts.js';
import { COINGECKO_ATTRIBUTION } from '@/services/coingecko/types.js';

const SECTIONS = ['profile', 'market', 'links', 'developer', 'community', 'sentiment'] as const;

export const getCoinTool = tool('coingecko_get_coin', {
  title: 'coingecko-mcp-server: get coin',
  description:
    'Deep profile for a single coin: description, categories, genesis date, homepage/whitepaper/repo/social links, full market data (price, cap, supply, ATH/ATL, multi-window price change), developer activity (GitHub stars/forks/commits), community stats, and sentiment vote split. The full picture for "tell me everything about Ethereum". The id must be a CoinGecko slug (resolve tickers with coingecko_search_coins). Use sections to fetch only part of the large record. Note: categories here are display names (e.g. "Layer 1 (L1)"), not the category_id slugs from coingecko_list_categories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'coin_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned 404 for the slug — it is not a recognized CoinGecko id.',
      recovery:
        'Verify the slug with coingecko_search_coins — IDs are slugs (bitcoin), not tickers (BTC).',
    },
    ...COINGECKO_SERVICE_ERRORS,
  ],

  input: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        'CoinGecko slug (e.g. "ethereum"). Not a ticker — resolve with coingecko_search_coins.',
      ),
    vs_currency: z
      .string()
      .min(1)
      .default('usd')
      .describe(
        'Currency for the market-data figures (price, cap, ATH/ATL). Single currency; defaults to "usd".',
      ),
    sections: z
      .array(z.enum(SECTIONS))
      .optional()
      .describe(
        'Subset of sections to return: profile, market, links, developer, community, sentiment. Omit for all sections.',
      ),
  }),

  output: z.object({
    id: z.string().describe('CoinGecko slug.'),
    symbol: z.string().describe('Ticker symbol.'),
    name: z.string().describe('Display name.'),
    profile: z
      .object({
        description: z
          .string()
          .optional()
          .describe('Long-form description (English), when available.'),
        categories: z
          .array(z.string())
          .describe('Category display names (e.g. "Layer 1 (L1)") — not category_id slugs.'),
        genesisDate: z
          .string()
          .optional()
          .describe('Genesis/launch date (ISO 8601), when available.'),
        hashingAlgorithm: z.string().optional().describe('Hashing algorithm, when available.'),
        countryOrigin: z.string().optional().describe('Country of origin, when available.'),
      })
      .optional()
      .describe(
        'Identity and descriptive metadata. Present when the profile section is requested.',
      ),
    market: z
      .object({
        currentPrice: z
          .number()
          .optional()
          .describe('Current price in vs_currency, when available.'),
        marketCap: z
          .number()
          .optional()
          .describe('Market capitalization in vs_currency, when available.'),
        fullyDilutedValuation: z
          .number()
          .optional()
          .describe('Fully diluted valuation in vs_currency, when available.'),
        circulatingSupply: z
          .number()
          .optional()
          .describe('Circulating supply (coin units), when available.'),
        totalSupply: z.number().optional().describe('Total supply (coin units), when available.'),
        maxSupply: z.number().optional().describe('Maximum supply (coin units), when available.'),
        ath: z
          .object({
            price: z.number().describe('All-time-high price in vs_currency.'),
            date: z.string().optional().describe('All-time-high date (ISO 8601), when available.'),
          })
          .optional()
          .describe('All-time high, when available.'),
        atl: z
          .object({
            price: z.number().describe('All-time-low price in vs_currency.'),
            date: z.string().optional().describe('All-time-low date (ISO 8601), when available.'),
          })
          .optional()
          .describe('All-time low, when available.'),
        priceChangePct: z
          .object({
            d24h: z
              .number()
              .optional()
              .describe('24-hour price change percentage, when available.'),
            d7d: z.number().optional().describe('7-day price change percentage, when available.'),
            d30d: z.number().optional().describe('30-day price change percentage, when available.'),
            d1y: z.number().optional().describe('1-year price change percentage, when available.'),
          })
          .describe(
            'Multi-window price change percentages (each field present only when upstream provides it).',
          ),
      })
      .optional()
      .describe('Market data in vs_currency. Present when the market section is requested.'),
    links: z
      .object({
        homepage: z.array(z.string()).describe('Homepage URLs (may be empty).'),
        whitepaper: z.string().optional().describe('Whitepaper URL, when available.'),
        repos: z
          .array(z.string())
          .describe('Source-code repository URLs (GitHub/Bitbucket; may be empty).'),
        subreddit: z.string().optional().describe('Subreddit URL, when available.'),
        twitter: z.string().optional().describe('Twitter/X handle (screen name), when available.'),
        telegram: z.string().optional().describe('Telegram channel identifier, when available.'),
      })
      .optional()
      .describe('Official and social links. Present when the links section is requested.'),
    developer: z
      .object({
        stars: z.number().optional().describe('GitHub stars, when available.'),
        forks: z.number().optional().describe('GitHub forks, when available.'),
        commits4w: z.number().optional().describe('Commits in the last 4 weeks, when available.'),
        totalIssues: z.number().optional().describe('Total issues, when available.'),
        closedIssues: z.number().optional().describe('Closed issues, when available.'),
      })
      .optional()
      .describe('Developer activity. Present when the developer section is requested.'),
    community: z
      .object({
        redditSubscribers: z.number().optional().describe('Reddit subscribers, when available.'),
      })
      .optional()
      .describe(
        'Community stats (CoinGecko no longer returns Twitter follower counts). Present when the community section is requested.',
      ),
    sentiment: z
      .object({
        upPercentage: z.number().optional().describe('Percentage of up votes, when available.'),
        downPercentage: z.number().optional().describe('Percentage of down votes, when available.'),
      })
      .optional()
      .describe('Sentiment vote split. Present when the sentiment section is requested.'),
    attribution: z.string().describe('Required data-source attribution.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('coingecko_get_coin', { id: input.id, sections: input.sections });
    const detail = await getCoinGeckoService().coinDetail(input.id, input.vs_currency, ctx);
    if (!detail) {
      throw ctx.fail('coin_not_found', `Coin "${input.id}" not found.`, {
        id: input.id,
        ...ctx.recoveryFor('coin_not_found'),
      });
    }

    // Omitted or empty array → all sections. An empty selection that returned a
    // bare id/symbol/name record is a footgun (form clients send [] for an unset
    // array field), so coalesce it to the documented "all sections" default.
    const want = new Set<(typeof SECTIONS)[number]>(
      input.sections && input.sections.length > 0 ? input.sections : SECTIONS,
    );
    return {
      id: detail.id,
      symbol: detail.symbol,
      name: detail.name,
      ...(want.has('profile') && { profile: detail.profile }),
      ...(want.has('market') && { market: detail.market }),
      ...(want.has('links') && { links: detail.links }),
      ...(want.has('developer') && { developer: detail.developer }),
      ...(want.has('community') && { community: detail.community }),
      ...(want.has('sentiment') && { sentiment: detail.sentiment }),
      attribution: COINGECKO_ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = [`# ${result.name} (${result.symbol})`, `**id:** \`${result.id}\``];

    if (result.profile) {
      const p = result.profile;
      lines.push('\n## Profile');
      if (p.categories.length) lines.push(`**Categories:** ${p.categories.join(', ')}`);
      if (p.genesisDate) lines.push(`**Genesis:** ${p.genesisDate}`);
      if (p.hashingAlgorithm) lines.push(`**Hashing algorithm:** ${p.hashingAlgorithm}`);
      if (p.countryOrigin) lines.push(`**Country:** ${p.countryOrigin}`);
      if (p.description) lines.push(`\n${p.description}`);
    }

    if (result.market) {
      const m = result.market;
      lines.push('\n## Market');
      if (m.currentPrice != null) lines.push(`**Price:** ${m.currentPrice}`);
      if (m.marketCap != null) lines.push(`**Market cap:** ${m.marketCap}`);
      if (m.fullyDilutedValuation != null)
        lines.push(`**Fully diluted valuation:** ${m.fullyDilutedValuation}`);
      if (m.circulatingSupply != null) lines.push(`**Circulating supply:** ${m.circulatingSupply}`);
      if (m.totalSupply != null) lines.push(`**Total supply:** ${m.totalSupply}`);
      if (m.maxSupply != null) lines.push(`**Max supply:** ${m.maxSupply}`);
      if (m.ath) lines.push(`**ATH:** ${m.ath.price}${m.ath.date ? ` (${m.ath.date})` : ''}`);
      if (m.atl) lines.push(`**ATL:** ${m.atl.price}${m.atl.date ? ` (${m.atl.date})` : ''}`);
      const pc = m.priceChangePct;
      const changes: string[] = [];
      if (pc.d24h != null) changes.push(`24h ${pc.d24h.toFixed(2)}%`);
      if (pc.d7d != null) changes.push(`7d ${pc.d7d.toFixed(2)}%`);
      if (pc.d30d != null) changes.push(`30d ${pc.d30d.toFixed(2)}%`);
      if (pc.d1y != null) changes.push(`1y ${pc.d1y.toFixed(2)}%`);
      if (changes.length) lines.push(`**Price change:** ${changes.join(' · ')}`);
    }

    if (result.links) {
      const l = result.links;
      lines.push('\n## Links');
      if (l.homepage.length) lines.push(`**Homepage:** ${l.homepage.join(', ')}`);
      if (l.whitepaper) lines.push(`**Whitepaper:** ${l.whitepaper}`);
      if (l.repos.length) lines.push(`**Repos:** ${l.repos.join(', ')}`);
      if (l.subreddit) lines.push(`**Subreddit:** ${l.subreddit}`);
      if (l.twitter) lines.push(`**Twitter:** @${l.twitter}`);
      if (l.telegram) lines.push(`**Telegram:** ${l.telegram}`);
    }

    if (result.developer) {
      const d = result.developer;
      const dev: string[] = [];
      if (d.stars != null) dev.push(`stars ${d.stars}`);
      if (d.forks != null) dev.push(`forks ${d.forks}`);
      if (d.commits4w != null) dev.push(`commits/4w ${d.commits4w}`);
      if (d.totalIssues != null) dev.push(`issues ${d.totalIssues}`);
      if (d.closedIssues != null) dev.push(`closed ${d.closedIssues}`);
      lines.push('\n## Developer');
      lines.push(dev.length ? dev.join(' · ') : '_No developer data._');
    }

    if (result.community) {
      lines.push('\n## Community');
      lines.push(
        result.community.redditSubscribers != null
          ? `**Reddit subscribers:** ${result.community.redditSubscribers}`
          : '_No community data._',
      );
    }

    if (result.sentiment) {
      const s = result.sentiment;
      lines.push('\n## Sentiment');
      const parts: string[] = [];
      if (s.upPercentage != null) parts.push(`up ${s.upPercentage.toFixed(1)}%`);
      if (s.downPercentage != null) parts.push(`down ${s.downPercentage.toFixed(1)}%`);
      lines.push(parts.length ? parts.join(' · ') : '_No sentiment data._');
    }

    lines.push(`\n_${result.attribution}_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
