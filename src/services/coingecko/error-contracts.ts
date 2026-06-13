/**
 * @fileoverview Service-layer failure modes the CoinGecko service can surface,
 * plus a `recoveryFor` resolver. Service code can't reach `ctx.recoveryFor` (no
 * Context), so it spreads `recoveryFor(reason)` into the error factory's `data`
 * arg — the framework mirrors `data.recovery.hint` into the wire payload's
 * `content[]` text, so clients get the same actionable hint a handler-level
 * `ctx.fail` would carry.
 *
 * These three reasons are upstream/transport failures shared across every tool
 * that calls the service. Domain-specific reasons (coin_not_found, all_missing,
 * unknown_category, invalid_range) are declared inline on the individual tools.
 * @module src/services/coingecko/error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Failure modes the CoinGecko service layer surfaces. Tools spread these into
 * their own `errors[]` so the declared contract matches what reaches the wire.
 */
export const COINGECKO_SERVICE_ERRORS = [
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'CoinGecko returned HTTP 429 — the shared keyless pool is throttled, or the Demo-tier quota was hit.',
    recovery:
      'Wait a few seconds and retry; set COINGECKO_API_KEY for a higher rate ceiling on bursty workflows.',
    retryable: true,
  },
  {
    reason: 'upstream_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CoinGecko was unreachable or returned a 5xx/HTML error after all retry attempts.',
    recovery: 'Retry after a brief delay; CoinGecko was unreachable across all retry attempts.',
    retryable: true,
  },
  {
    reason: 'invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'CoinGecko returned a body that could not be parsed as JSON.',
    recovery:
      'Retry the request; CoinGecko returned a malformed response that could not be parsed.',
    retryable: true,
  },
] as const;

export type CoinGeckoServiceReason = (typeof COINGECKO_SERVICE_ERRORS)[number]['reason'];

const REASON_TO_RECOVERY = new Map<CoinGeckoServiceReason, string>(
  COINGECKO_SERVICE_ERRORS.map((entry) => [entry.reason, entry.recovery]),
);

/**
 * Service-layer counterpart to `ctx.recoveryFor`. Returns `{ recovery: { hint } }`
 * for the contract reason, spread into the error factory's `data` so the wire
 * payload carries the same hint a handler-level `ctx.fail` would.
 *
 * @example
 *   throw serviceUnavailable(msg, { reason: 'upstream_unreachable', ...recoveryFor('upstream_unreachable') });
 */
export function recoveryFor(reason: CoinGeckoServiceReason): { recovery: { hint: string } } {
  const hint = REASON_TO_RECOVERY.get(reason);
  if (hint === undefined) {
    throw new Error(`recoveryFor: no recovery hint registered for reason "${reason}"`);
  }
  return { recovery: { hint } };
}
