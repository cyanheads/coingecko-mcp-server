/**
 * @fileoverview Tests for the server config — `COINGECKO_API_KEY` resolution.
 * A blank Claude Desktop / MCPB field reaches the process as `""` or as the
 * unsubstituted `${user_config.coingecko_api_key}` placeholder; both must read
 * as "no key" so the client never sends a garbage `x-cg-demo-api-key` header.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** `getServerConfig()` caches on first call, so each case loads a fresh module. */
async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig — COINGECKO_API_KEY', () => {
  it('reads an unset variable as no key', async () => {
    vi.stubEnv('COINGECKO_API_KEY', undefined);
    expect((await loadConfig()).apiKey).toBeUndefined();
  });

  it('reads an empty string as no key', async () => {
    vi.stubEnv('COINGECKO_API_KEY', '');
    expect((await loadConfig()).apiKey).toBeUndefined();
  });

  it('reads an unsubstituted MCPB placeholder as no key', async () => {
    vi.stubEnv('COINGECKO_API_KEY', `\${user_config.coingecko_api_key}`);
    expect((await loadConfig()).apiKey).toBeUndefined();
  });

  it('returns a real key verbatim', async () => {
    vi.stubEnv('COINGECKO_API_KEY', 'CG-demo-123');
    expect((await loadConfig()).apiKey).toBe('CG-demo-123');
  });
});
