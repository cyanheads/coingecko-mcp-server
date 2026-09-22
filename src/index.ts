#!/usr/bin/env node
/**
 * @fileoverview coingecko-mcp-server MCP server entry point. Wires the CoinGecko
 * service and the full tool/resource/prompt surface into createApp().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';

import { coinResearchPrompt } from './mcp-server/prompts/definitions/coin-research.prompt.js';
import { coinResource } from './mcp-server/resources/definitions/coin.resource.js';
import { globalResource } from './mcp-server/resources/definitions/global.resource.js';
import { getCoinTool } from './mcp-server/tools/definitions/get-coin.tool.js';
import { getGlobalTool } from './mcp-server/tools/definitions/get-global.tool.js';
import { getMarketChartTool } from './mcp-server/tools/definitions/get-market-chart.tool.js';
import { getPricesTool } from './mcp-server/tools/definitions/get-prices.tool.js';
import { getTrendingTool } from './mcp-server/tools/definitions/get-trending.tool.js';
import { listCategoriesTool } from './mcp-server/tools/definitions/list-categories.tool.js';
import { listMarketsTool } from './mcp-server/tools/definitions/list-markets.tool.js';
import { searchCoinsTool } from './mcp-server/tools/definitions/search-coins.tool.js';
import { initCoinGeckoService } from './services/coingecko/coingecko-service.js';

await createApp({
  name: 'coingecko-mcp-server',
  title: 'coingecko-mcp-server',
  tools: [
    searchCoinsTool,
    getPricesTool,
    listCategoriesTool,
    listMarketsTool,
    getCoinTool,
    getMarketChartTool,
    getTrendingTool,
    getGlobalTool,
  ],
  resources: [coinResource, globalResource],
  prompts: [coinResearchPrompt],
  // No tool calls ctx.requestInput and nothing is held per session, so HTTP
  // serves stateless. An explicit MCP_SESSION_MODE still overrides this.
  sessionMode: 'stateless',
  instructions:
    'Cryptocurrency market data from CoinGecko (v3 REST API). CoinGecko keys all data by slug (bitcoin, ethereum), NOT by ticker (BTC, ETH) — and tickers are not unique. Resolve any name or ticker to a slug with coingecko_search_coins FIRST, then chain the returned id into the ID-keyed tools (coingecko_get_prices, coingecko_get_coin, coingecko_get_market_chart). coingecko_get_prices reports any unresolved ids in its missing field rather than erroring. Data refreshes ~every 60s (not tick-level). Runs keyless by default; set COINGECKO_API_KEY for a higher rate ceiling. Data provided by CoinGecko.',
  landing: {
    requireAuth: false,
    tagline:
      'Cryptocurrency prices, markets, history, trending, and deep coin metadata via CoinGecko.',
    repoRoot: 'https://github.com/cyanheads/coingecko-mcp-server',
    links: [
      { label: 'CoinGecko', href: 'https://www.coingecko.com/', external: true },
      {
        label: 'CoinGecko API docs',
        href: 'https://docs.coingecko.com/reference/introduction',
        external: true,
      },
      {
        label: 'Get a Demo API key',
        href: 'https://www.coingecko.com/en/api/pricing',
        external: true,
      },
    ],
    envExample: {
      COINGECKO_API_KEY: 'your-coingecko-demo-api-key',
    },
  },
  setup() {
    initCoinGeckoService();
  },
});
