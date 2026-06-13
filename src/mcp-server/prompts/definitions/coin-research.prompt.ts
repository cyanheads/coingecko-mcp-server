/**
 * @fileoverview coingecko_coin_research — structures a full single-coin research
 * pass, guiding the agent through the search → get_coin → get_market_chart →
 * get_global tool chain.
 * @module src/mcp-server/prompts/definitions/coin-research.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const coinResearchPrompt = prompt('coingecko_coin_research', {
  description:
    'Structures a full single-coin research pass — resolve the slug, pull deep metadata, sample recent price history, and frame it against the global market. Guides the agent through the search → get_coin → get_market_chart → get_global chain.',
  title: 'coingecko-mcp-server: coin research',
  args: z.object({
    coin: z
      .string()
      .min(1)
      .describe(
        'The coin to research — a name, ticker symbol, or CoinGecko slug (e.g. "Ethereum", "ETH", or "ethereum").',
      ),
  }),

  generate: (args) => [
    {
      role: 'assistant' as const,
      content: {
        type: 'text' as const,
        text: [
          'You are a cryptocurrency research assistant working with the coingecko-mcp-server tools.',
          'CoinGecko keys all data by slug (e.g. "ethereum"), never by ticker — always resolve first.',
          'Ground every claim in tool output; do not infer figures the tools did not return.',
          'CoinGecko data refreshes roughly every 60 seconds and is not tick-level — note this when precision matters.',
        ].join(' '),
      },
    },
    {
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          `Research the cryptocurrency: **${args.coin}**.`,
          '',
          'Work through these steps:',
          `1. **Resolve the slug.** Call \`coingecko_search_coins\` with "${args.coin}". Pick the best-ranked candidate (lower market_cap_rank = larger) and use its \`id\` for every following step.`,
          '2. **Pull the deep profile.** Call `coingecko_get_coin` with that id. Summarize what it is (description, categories), its market standing (price, market cap, supply, ATH/ATL), developer activity, and sentiment.',
          '3. **Sample recent history.** Call `coingecko_get_market_chart` with mode=recent, days=30, to characterize the recent price trend (direction, volatility, notable moves).',
          '4. **Frame against the market.** Call `coingecko_get_global` to report total market cap, BTC/ETH dominance, and 24h market direction, then situate this coin within that backdrop.',
          '',
          'Finish with a concise synthesis: what this coin is, where it stands, how it has moved recently, and how that fits the current market. Attribute data to CoinGecko.',
        ].join('\n'),
      },
    },
  ],
});
