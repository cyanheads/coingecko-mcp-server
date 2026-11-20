/**
 * @fileoverview Wire contracts for coin discovery, coin records, and global data.
 * @module tests/mcp-server/tools/coin-global.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, expect, it, vi } from 'vitest';

import { coinResource } from '@/mcp-server/resources/definitions/coin.resource.js';
import { globalResource } from '@/mcp-server/resources/definitions/global.resource.js';
import { getCoinTool } from '@/mcp-server/tools/definitions/get-coin.tool.js';
import { getGlobalTool } from '@/mcp-server/tools/definitions/get-global.tool.js';
import { searchCoinsTool } from '@/mcp-server/tools/definitions/search-coins.tool.js';
import { initCoinGeckoService } from '@/services/coingecko/coingecko-service.js';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
  initCoinGeckoService();
});

it('continues to search by name and return only requested profile sections', async () => {
  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({ coins: [{ id: 'usd-coin', symbol: 'USDC', name: 'USDC' }] }),
  );
  const search = await runToolContract(searchCoinsTool, { query: 'USDC' });
  expect(search.structuredContent?.coins).toEqual([
    { id: 'usd-coin', symbol: 'USDC', name: 'USDC' },
  ]);
  expect(search.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('usd-coin') }),
  );

  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({ id: 'usd-coin', name: 'USDC', symbol: 'usdc', categories: ['Stablecoins'] }),
  );
  const coin = await runToolContract(getCoinTool, { id: 'usd-coin', sections: ['profile'] });
  expect(coin.structuredContent?.profile).toEqual({ categories: ['Stablecoins'] });
  expect(coin.structuredContent).not.toHaveProperty('market');
  expect(coin.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('Stablecoins') }),
  );
  expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
});

it('resolves a case-sensitive contract into a slug and renders the result', async () => {
  const address = 'THb4CqiFdwNHsWsQCs4JhzwjMWys4aqCbF';
  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({ id: 'usd-coin', symbol: 'usdc', name: 'USDC', market_cap_rank: 5 }),
  );
  const search = await runToolContract(searchCoinsTool, {
    platform: 'tron',
    contract_address: address,
  });
  expect(search.structuredContent?.coins).toEqual([
    { id: 'usd-coin', symbol: 'usdc', name: 'USDC', marketCapRank: 5 },
  ]);
  expect(search.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('usd-coin') }),
  );
  expect(new URL(mockFetchWithTimeout.mock.calls[0]?.[0]).pathname).toBe(
    `/api/v3/coins/tron/contract/${address}`,
  );
});

it.each([
  {},
  { platform: 'ethereum' },
  { contract_address: '0xAbC' },
  { query: 'USDC', platform: 'ethereum', contract_address: '0xAbC' },
])('rejects invalid selector combinations before fetching (%j)', async (selector) => {
  const result = await runToolContract(searchCoinsTool, selector);
  expect(result.isError).toBe(true);
  const hint = 'Pass query alone, or pass both platform and contract_address without query.';
  expect(result.structuredContent?.error).toMatchObject({
    data: { reason: 'invalid_coin_selector', recovery: { hint } },
  });
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining(hint) }),
  );
  expect(mockFetchWithTimeout).not.toHaveBeenCalled();
});

it('reports an unresolved contract with recovery on both surfaces', async () => {
  mockFetchWithTimeout.mockRejectedValueOnce(
    new McpError(JsonRpcErrorCode.NotFound, 'No matching coin', { statusCode: 404 }),
  );
  const result = await runToolContract(searchCoinsTool, {
    platform: 'ethereum',
    contract_address: '0xAbC',
  });
  expect(result.isError).toBe(true);
  const hint =
    'Verify the CoinGecko asset platform ID and the exact contract address, including its casing.';
  expect(result.structuredContent?.error).toMatchObject({
    data: { reason: 'contract_not_found', recovery: { hint } },
  });
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining(hint) }),
  );
});

it('lists contract platform details and quote-currency market fields on both surfaces', async () => {
  const record = {
    id: 'usd-coin',
    symbol: 'usdc',
    name: 'USDC',
    asset_platform_id: 'ethereum',
    platforms: { ethereum: '0xAbC', base: '0xBase', '': '' },
    detail_platforms: { ethereum: { contract_address: '0xAbC', decimal_place: 0 } },
    market_cap_rank: 5,
    market_data: {
      current_price: { usd: 1, eur: 0.9 },
      total_volume: { usd: 120, eur: 110 },
      high_24h: { eur: 0.95 },
      low_24h: { eur: 0.85 },
    },
  };
  mockFetchWithTimeout.mockResolvedValueOnce(Response.json(record));
  const coin = await runToolContract(getCoinTool, {
    id: 'usd-coin',
    vs_currency: 'eur',
    sections: ['market', 'platforms'],
  });
  const platforms = {
    assetPlatformId: 'ethereum',
    contracts: [
      { platform: 'ethereum', contractAddress: '0xAbC', decimalPlace: 0 },
      { platform: 'base', contractAddress: '0xBase' },
    ],
  };
  expect(coin.structuredContent?.platforms).toEqual(platforms);
  expect(coin.structuredContent?.market).toMatchObject({
    totalVolume: 110,
    high24h: 0.95,
    low24h: 0.85,
    marketCapRank: 5,
  });
  for (const value of [
    'ethereum: 0xAbC (0 decimals)',
    'base: 0xBase',
    '**24h volume:** 110',
    '**24h high:** 0.95',
    '**24h low:** 0.85',
    '**Market-cap rank:** 5',
  ]) {
    expect(coin.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining(value) }),
    );
  }
  mockFetchWithTimeout.mockResolvedValueOnce(Response.json(record));
  const resource = await coinResource.handler(
    { id: 'usd-coin' },
    createMockContext({ errors: coinResource.errors }),
  );
  expect(resource).toMatchObject({ platforms, market: { totalVolume: 120 } });
});

it('omits native-coin placeholders and renders an empty contract list', async () => {
  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
      asset_platform_id: null,
      platforms: { '': '' },
      detail_platforms: { '': { contract_address: '', decimal_place: null } },
    }),
  );
  const result = await runToolContract(getCoinTool, { id: 'ethereum', sections: ['platforms'] });
  expect(result.structuredContent?.platforms).toEqual({ contracts: [] });
  expect(result.structuredContent).not.toHaveProperty('market');
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('No contracts listed') }),
  );
  expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
});

it('surfaces sparse global data without fabricating zeros', async () => {
  const snapshot = {
    data: {
      total_market_cap: { usd: 7 },
      fear_and_greed_index: { value: 0, sentiment: 'upstream_value' },
      market_cap_percentage: { btc: 60.12345, usdt: 7.12345, eth: 0 },
      ongoing_icos: null,
      markets: 0,
    },
  };
  const expected = {
    totalMarketCap: 7,
    markets: 0,
    btcDominance: 60.12345,
    ethDominance: 0,
    fearGreedIndex: { value: 0, sentiment: 'upstream_value' },
    dominance: [
      { symbol: 'btc', percentage: 60.12345 },
      { symbol: 'usdt', percentage: 7.12345 },
      { symbol: 'eth', percentage: 0 },
    ],
    attribution: 'Data provided by CoinGecko',
  };
  mockFetchWithTimeout.mockResolvedValueOnce(Response.json(snapshot));
  const result = await runToolContract(getGlobalTool, {});
  expect(result.structuredContent).toEqual(expected);
  for (const value of [
    '**Fear & Greed index:** 0 (upstream_value)',
    '- usdt: 7.12345%',
    '**Markets:** 0',
  ]) {
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining(value) }),
    );
  }
  expect(result.content).not.toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('Ongoing ICOs') }),
  );
  mockFetchWithTimeout.mockResolvedValueOnce(Response.json(snapshot));
  expect(await globalResource.handler({}, createMockContext())).toEqual(expected);
});

it('omits a partial sentiment index and represents an absent dominance map', async () => {
  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({
      data: { total_market_cap: { usd: 7 }, fear_and_greed_index: { value: 0 } },
    }),
  );
  const result = await runToolContract(getGlobalTool, {});
  expect(result.structuredContent).toEqual({
    totalMarketCap: 7,
    dominance: [],
    attribution: 'Data provided by CoinGecko',
  });
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('No asset dominance data') }),
  );
  expect(result.content).not.toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('Fear & Greed index') }),
  );
});

it('keeps an unsupported global quote currency distinct from sparse data', async () => {
  mockFetchWithTimeout.mockResolvedValueOnce(
    Response.json({ data: { total_market_cap: { usd: 7 } } }),
  );
  const result = await runToolContract(getGlobalTool, { vs_currency: 'unsupported-quote' });
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.error).toMatchObject({
    data: {
      reason: 'unsupported_currency',
      recovery: { hint: expect.stringContaining('Use a supported currency code') },
    },
  });
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('Use a supported currency code') }),
  );
});
