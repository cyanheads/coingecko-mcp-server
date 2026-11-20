/**
 * @fileoverview CoinGecko transport tests through the installed framework's real
 * fetch/status/retry pipeline, with only the network boundary replaced.
 * @module tests/services/coingecko/api-client.test
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { defaultIsTransient } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coinResource } from '@/mcp-server/resources/definitions/coin.resource.js';
import { getCoinTool } from '@/mcp-server/tools/definitions/get-coin.tool.js';
import { searchCoinsTool } from '@/mcp-server/tools/definitions/search-coins.tool.js';
import { CoinGeckoApiClient } from '@/services/coingecko/api-client.js';
import { CoinGeckoService, initCoinGeckoService } from '@/services/coingecko/coingecko-service.js';

const fetchMock = vi.fn<typeof fetch>();
const client = () => new CoinGeckoApiClient({ timeoutMs: 1000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe('real transport characterization', () => {
  it('keeps framework status codes, permanent 501, and nullable 404', async () => {
    vi.stubGlobal('fetch', fetchMock);
    for (const [status, code, transient] of [
      [400, JsonRpcErrorCode.InvalidParams, false],
      [401, JsonRpcErrorCode.Unauthorized, false],
      [408, JsonRpcErrorCode.Timeout, true],
      [425, JsonRpcErrorCode.Timeout, true],
      [429, JsonRpcErrorCode.RateLimited, true],
      [501, JsonRpcErrorCode.ServiceUnavailable, false],
      [503, JsonRpcErrorCode.ServiceUnavailable, true],
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status }));
      const error = await client()
        .getJson('test', '/search', undefined, undefined)
        .catch((e) => e);
      expect(error.code).toBe(code);
      expect(defaultIsTransient(error)).toBe(transient);
    }
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await client().getJsonOrNull('test', '/coins/nope', undefined, undefined)).toBeNull();
  });

  it('runs the actual retry loop across multiple attempts and honors Retry-After', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"coins":[]}'));
    const result = new CoinGeckoService(client()).search('coin', createMockContext());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('upstream failure contracts (#9)', () => {
  it('classifies a timeout while reading a successful response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementationOnce(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options?.signal?.addEventListener(
                'abort',
                () => controller.error(options.signal?.reason),
                { once: true },
              );
            },
          }),
        ),
    );
    const result = client()
      .getJson('test', '/search', undefined, undefined)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
  });

  it('distinguishes an expired caller deadline from a retryable attempt timeout', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort(new DOMException('caller deadline', 'TimeoutError'));
    const error = await client()
      .getJson('test', '/search', undefined, controller.signal)
      .catch((e) => e);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'upstream_deadline', retryable: false });
    expect(defaultIsTransient(error)).toBe(false);
    const contract = searchCoinsTool.errors?.find((entry) => entry.reason === 'upstream_deadline');
    expect(contract?.code).toBe(error.code);
    expect(contract?.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([
    [400, 'upstream_invalid_params', false, JsonRpcErrorCode.InvalidParams],
    [401, 'upstream_unauthorized', false, JsonRpcErrorCode.Unauthorized],
    [403, 'upstream_forbidden', false, JsonRpcErrorCode.Forbidden],
    [404, 'upstream_not_found', false, JsonRpcErrorCode.NotFound],
    [405, 'upstream_invalid_request', false, JsonRpcErrorCode.InvalidRequest],
    [409, 'upstream_conflict', false, JsonRpcErrorCode.Conflict],
    [422, 'upstream_validation_failed', false, JsonRpcErrorCode.ValidationError],
    [408, 'upstream_timeout', true, JsonRpcErrorCode.Timeout],
    [425, 'upstream_timeout', true, JsonRpcErrorCode.Timeout],
    [429, 'rate_limited', true, JsonRpcErrorCode.RateLimited],
    [501, 'upstream_http_error', false, JsonRpcErrorCode.ServiceUnavailable],
    [503, 'upstream_unreachable', true, JsonRpcErrorCode.ServiceUnavailable],
  ] as const)('declares and renders HTTP %s as %s', async (status, reason, retryable, code) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"Invalid currency"}', {
        status,
        headers: { 'retry-after': '60' },
      }),
    );
    const error = await client()
      .getJson('test', '/search', undefined, undefined)
      .catch((e) => e);
    expect(error.data.reason).toBe(reason);
    expect(error.code).toBe(code);
    expect(error.data.retryable).toBe(retryable);
    expect(defaultIsTransient(error)).toBe(retryable);
    const contract = searchCoinsTool.errors?.find((entry) => entry.reason === reason);
    expect(contract?.code).toBe(error.code);
    expect(contract?.retryable).toBe(retryable);
    expect(error.message).toContain('Invalid currency');
    const run = await runToolContract(
      {
        ...searchCoinsTool,
        handler: async () => {
          throw error;
        },
      },
      { query: 'coin' },
    );
    expect(run.structuredContent?.error).toMatchObject({ code: error.code, data: { reason } });
    const text = run.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Invalid currency');
    expect(text).toContain(error.data.recovery.hint);
    if (status === 429) expect(text).toContain('Retry-After');
  });

  it.each([
    { status: { error_code: 10012, error_message: 'Your request exceeds the allowed time range' } },
    {
      error: {
        status: { error_code: 10012, error_message: 'Your request exceeds the allowed time range' },
      },
    },
  ])('gives history-window recovery for confirmed 10012 envelopes', async (body) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 401 }));
    const error = await client()
      .getJson('test', '/coins/x/market_chart', undefined, undefined)
      .catch((e) => e);
    expect(error.data.reason).toBe('upstream_unauthorized');
    expect(error.message).toContain('allowed time range');
    expect(error.data.recovery.hint).toContain('365');
    expect(error.data.recovery.hint).not.toContain('COINGECKO_API_KEY');
  });

  it.each(['<html>private page</html>', 'not JSON'])(
    'does not promote an opaque body to the explanation',
    async (body) => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
      const error = await client()
        .getJson('test', '/search', undefined, undefined)
        .catch((e) => e);
      expect(error.data.reason).toBe('upstream_invalid_params');
      expect(error.message).not.toContain(body);
      expect(error.data.responseBody).toBe(body);
      const run = await runToolContract(
        {
          ...searchCoinsTool,
          handler: async () => {
            throw error;
          },
        },
        { query: 'coin' },
      );
      expect(run.structuredContent?.error).toMatchObject({
        code: error.code,
        data: { reason: 'upstream_invalid_params' },
      });
      expect(run.structuredContent?.error?.data).not.toHaveProperty('body');
      expect(run.structuredContent?.error?.data).not.toHaveProperty('responseBody');
      const text = run.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(error.data.recovery.hint);
      expect(text).not.toContain(body);
    },
  );

  it('bounds explanations before sanitizing markup and control characters', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: `<b>bad</b>\u0000\n${'x'.repeat(400)}` }), {
        status: 400,
      }),
    );
    const error = await client()
      .getJson('test', '/search', undefined, undefined)
      .catch((e) => e);
    expect(error.message).not.toContain('<b>');
    expect(error.message).not.toContain('\u0000');
    expect(error.message.length).toBeLessThan(500);
    expect(error.message).toContain(`CoinGecko: bad  ${'x'.repeat(288)}`);
    expect(error.message).not.toContain('x'.repeat(289));
  });

  it('declares per-attempt timeout separately and preserves caller cancellation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = client()
      .getJson('test', '/search', undefined, undefined)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    const controller = new AbortController();
    const cancelled = client()
      .getJson('test', '/search', undefined, controller.signal)
      .catch((e) => e);
    controller.abort();
    const error = await cancelled;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data.reason).not.toBe('upstream_unreachable');
    expect(defaultIsTransient(error)).toBe(false);
  });
});

const coin = {
  id: 'bitcoin',
  name: 'Bitcoin',
  symbol: 'btc',
  market_data: { current_price: { usd: 1, btc: 1 }, price_change_percentage_24h: -3.04672 },
};

describe('coin currency characterization (#12)', () => {
  it('does one request for an ordinary quote and preserves legacy USD scalar fallback', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(Response.json(coin));
    const result = await new CoinGeckoService(client()).coinDetail(
      'bitcoin',
      'usd',
      createMockContext(),
    );
    expect(result?.market).toMatchObject({ currentPrice: 1, priceChangePct: { d24h: -3.04672 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('coin quote selection (#12)', () => {
  it('retains the original per-request exhausted attempt count inside the deadline envelope', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    const result = new CoinGeckoService(client())
      .coinDetail('bitcoin', 'usd', createMockContext())
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error.data.retryAttempts).toBe(4);
    expect(error.message.match(/failed after/g)).toHaveLength(1);
  });
  const runCoin = async (body: unknown, input: Record<string, unknown> = {}) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(Response.json(body));
    initCoinGeckoService();
    return runToolContract(getCoinTool, { id: 'bitcoin', sections: ['market'], ...input });
  };

  it.each(['usd', 'btc'])(
    'uses every %s map, preserving zero and omitting null/missing windows on both surfaces',
    async (currency) => {
      const run = await runCoin(
        {
          ...coin,
          market_data: {
            ...coin.market_data,
            price_change_percentage_7d: 88,
            price_change_percentage_30d: 99,
            price_change_percentage_1y: 111,
            price_change_percentage_24h_in_currency: { usd: -3.04672, btc: -0.11743 },
            price_change_percentage_7d_in_currency: { usd: 0, btc: 0 },
            price_change_percentage_30d_in_currency: { usd: null, btc: null },
            price_change_percentage_1y_in_currency: {},
          },
        },
        { vs_currency: currency },
      );
      expect(run.isError).not.toBe(true);
      expect(run.structuredContent?.market).toMatchObject({
        priceChangePct: {
          d24h: currency === 'usd' ? -3.04672 : -0.11743,
          d7d: 0,
        },
      });
      const changes = (run.structuredContent?.market as { priceChangePct: unknown } | undefined)
        ?.priceChangePct;
      expect(changes).not.toHaveProperty('d30d');
      expect(changes).not.toHaveProperty('d1y');
      const text = run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text.split('\n')).toContain(
        `**Price change:** 24h ${currency === 'usd' ? '-3.05' : '-0.12'}% · 7d 0.00%`,
      );
      expect(text).not.toMatch(/30d |1y /);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('never falls back to USD scalars for non-USD or explicit null maps', async () => {
    const btc = await runCoin(coin, { vs_currency: 'btc' });
    expect(btc.structuredContent?.market).toMatchObject({ priceChangePct: {} });
    expect(
      btc.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).not.toContain('**Price change:**');
    const usd = await runCoin({
      ...coin,
      market_data: {
        ...coin.market_data,
        price_change_percentage_24h_in_currency: null,
      },
    });
    expect(usd.structuredContent?.market).toMatchObject({ priceChangePct: {} });
    expect(
      usd.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).not.toContain('**Price change:**');
  });

  it('shares selected USD normalization with the resource', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...coin,
        market_data: {
          ...coin.market_data,
          price_change_percentage_24h_in_currency: { usd: 0 },
        },
      }),
    );
    initCoinGeckoService();
    const result = await coinResource.handler(
      { id: 'bitcoin' },
      createMockContext({ errors: coinResource.errors }),
    );
    expect(result.market.priceChangePct).toEqual({ d24h: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trusts an own null current-price key without consulting the catalog', async () => {
    const run = await runCoin(
      { ...coin, market_data: { current_price: { zzz: null } } },
      { vs_currency: 'zzz' },
    );
    expect(run.isError).not.toBe(true);
    expect(run.structuredContent?.market).toEqual({ priceChangePct: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { market_data: {} }, { market_data: { current_price: { usd: 1 } } }])(
    'checks only missing-key market requests against the authoritative catalog',
    async (record) => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock
        .mockResolvedValueOnce(Response.json({ ...coin, market_data: undefined, ...record }))
        .mockResolvedValueOnce(Response.json(['usd', 'btc']));
      initCoinGeckoService();
      const run = await runToolContract(getCoinTool, {
        id: 'bitcoin',
        vs_currency: 'zzz',
        sections: ['market'],
      });
      expect(run.isError).toBe(true);
      expect(run.structuredContent?.error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'unsupported_currency' },
      });
      expect(
        run.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      ).toContain('Use a supported currency code such as "usd", "eur", or "btc" for market data.');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/simple/supported_vs_currencies');
    },
  );

  it('keeps supported missing quotes sparse, skips catalog for profile-only, and rejects blank currency', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(Response.json({ ...coin, market_data: {} }))
      .mockResolvedValueOnce(Response.json(['usd', 'btc']));
    initCoinGeckoService();
    const sparse = await runToolContract(getCoinTool, { id: 'bitcoin', vs_currency: 'btc' });
    expect(sparse.isError).not.toBe(true);
    expect(sparse.structuredContent?.market).toEqual({ priceChangePct: {} });
    const sparseText = sparse.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(sparseText).toContain('## Market');
    expect(sparseText).not.toMatch(/\*\*(Price|Price change):\*\*/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(Response.json({ ...coin, market_data: {} }));
    const profile = await runToolContract(getCoinTool, {
      id: 'bitcoin',
      vs_currency: 'zzz',
      sections: ['profile'],
    });
    expect(profile.isError).not.toBe(true);
    expect(profile.structuredContent).not.toHaveProperty('market');
    const profileText = profile.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(profileText).toContain('## Profile');
    expect(profileText).not.toContain('## Market');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const invalid = await runToolContract(getCoinTool, { id: 'bitcoin', vs_currency: ' ' });
    expect(invalid.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('propagates catalog failure rather than declaring the currency unsupported', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(Response.json({ ...coin, market_data: {} }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    initCoinGeckoService();
    const run = await runToolContract(getCoinTool, { id: 'bitcoin', vs_currency: 'zzz' });
    expect(run.isError).toBe(true);
    expect(run.structuredContent?.error).toMatchObject({ data: { reason: 'upstream_forbidden' } });
    expect(
      run.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).toContain(
      'Check the Demo key and account access; this public API endpoint cannot use a Pro key.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'shares one deadline across primary and supplemental attempts/backoff (hanging=%s)',
    async (hanging) => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockImplementation(
        (_url, options) =>
          new Promise((resolve, reject) => {
            const supplemental = String(_url).includes('/simple/');
            const timer =
              supplemental && hanging
                ? undefined
                : setTimeout(
                    () =>
                      resolve(
                        supplemental
                          ? new Response('{}', { status: 503 })
                          : Response.json({ ...coin, market_data: {} }),
                      ),
                    supplemental ? 14000 : 10000,
                  );
            options?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(options.signal?.reason);
              },
              { once: true },
            );
          }),
      );
      initCoinGeckoService();
      const run = runToolContract(getCoinTool, { id: 'bitcoin', vs_currency: 'zzz' });
      await vi.advanceTimersByTimeAsync(50000);
      const result = await run;
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50000 },
      });
      expect(JSON.stringify(result.content)).toContain('50000ms');
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/coins/bitcoin');
      for (const [url] of fetchMock.mock.calls.slice(1))
        expect(String(url)).toContain('/simple/supported_vs_currencies');
    },
  );

  it('preserves caller cancellation during a hanging supplemental request', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    fetchMock
      .mockResolvedValueOnce(Response.json({ ...coin, market_data: {} }))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
            controller.abort();
          }),
      );
    initCoinGeckoService();
    const result = await runToolContract(
      getCoinTool,
      { id: 'bitcoin', vs_currency: 'zzz' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(
      result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).toContain('was aborted.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
