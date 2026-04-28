import type { GatewayToken } from '../types';

export interface BucketConfig {
  perMinute: number;
  burst: number;
  disabled: boolean;
}

export interface BucketDecision {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
  limit: number;
  outcome: 'allowed' | 'rejected' | 'bypassed';
}

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
  configSnapshot: BucketConfig;
}

export interface EnvDefaults {
  perMinute: number;
  burst: number;
  killSwitch: boolean;
}

const buckets = new Map<number, BucketState>();

const envDefaults: EnvDefaults = (() => {
  const perMinRaw = parseInt(process.env.RATE_LIMIT_PER_MINUTE_DEFAULT ?? '', 10);
  const burstRaw = parseInt(process.env.RATE_LIMIT_BURST_DEFAULT ?? '', 10);
  return {
    perMinute: Number.isFinite(perMinRaw) && perMinRaw > 0 ? perMinRaw : 60,
    burst: Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : 20,
    killSwitch: process.env.RATE_LIMIT_DISABLED === '1',
  };
})();

export function getEnvDefaults(): EnvDefaults {
  return envDefaults;
}

export function configFromToken(t: GatewayToken, defaults: EnvDefaults = envDefaults): BucketConfig {
  return {
    perMinute: t.rate_limit_per_minute ?? defaults.perMinute,
    burst: t.rate_limit_burst ?? defaults.burst,
    disabled: t.rate_limit_disabled === 1 || defaults.killSwitch,
  };
}

/**
 * INVARIANT: This function MUST remain fully synchronous. There must be no
 * `await`, microtask boundary, or async I/O between reading and writing
 * `state.tokens`. JavaScript single-threaded event-loop semantics guarantee
 * per-token race-freedom only while the function body completes within a
 * single synchronous execution. Adding async I/O here (e.g. write-through
 * cache, Turso UPDATE, Redis call) silently breaks Req 1.3 (concurrent
 * last-token correctness) without any test signal at unit level.
 *
 * If state needs to become persistent or shared across processes, replace
 * the implementation with one of: (a) atomic SQL `UPDATE … SET tokens =
 * tokens - 1 WHERE tokens >= 1` with rowcount check; (b) a per-token async
 * lock; (c) Redis Lua script. Do NOT just sprinkle `await` here.
 */
export function checkAndConsume(
  tokenId: number,
  _label: string,
  config: BucketConfig,
  now: number = performance.now(),
): BucketDecision {
  if (config.disabled) {
    return {
      allowed: true,
      remaining: config.burst,
      resetSeconds: 0,
      retryAfterSeconds: 0,
      limit: config.perMinute,
      outcome: 'bypassed',
    };
  }

  const refillPerSec = config.perMinute / 60;

  let state = buckets.get(tokenId);
  if (!state) {
    state = { tokens: config.burst, lastRefillMs: now, configSnapshot: config };
    buckets.set(tokenId, state);
  } else {
    const elapsedMs = Math.max(0, now - state.lastRefillMs);
    const refillTokens = (elapsedMs / 1000) * refillPerSec;
    state.tokens = Math.min(config.burst, Math.max(0, state.tokens + refillTokens));
    state.lastRefillMs = now;
    state.configSnapshot = config;
  }

  const allowed = state.tokens >= 1;
  if (allowed) state.tokens -= 1;

  const resetSeconds = state.tokens >= config.burst
    ? 0
    : Math.ceil((config.burst - state.tokens) / refillPerSec);
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil((1 - state.tokens) / refillPerSec));

  return {
    allowed,
    remaining: allowed ? Math.floor(state.tokens) : 0,
    resetSeconds,
    retryAfterSeconds,
    limit: config.perMinute,
    outcome: allowed ? 'allowed' : 'rejected',
  };
}

/**
 * Clone the response with `X-RateLimit-*` headers added. No-op when
 * `decision` is null or `outcome === 'bypassed'`. Note: `Retry-After` is
 * NOT added here — the 429 call site adds it via `errorResponse`'s
 * `options.headers`. Streaming (SSE) responses MUST NOT use this helper;
 * bake the headers into the `Response` constructor directly to preserve
 * body-stream affinity.
 */
export function withRateLimitHeaders(resp: Response, decision: BucketDecision | null): Response {
  if (!decision || decision.outcome === 'bypassed') return resp;
  const headers = new Headers(resp.headers);
  headers.set('X-RateLimit-Limit', String(decision.limit));
  headers.set('X-RateLimit-Remaining', String(decision.remaining));
  headers.set('X-RateLimit-Reset', String(decision.resetSeconds));
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export function getBucketState(tokenId: number): Readonly<BucketState> | undefined {
  return buckets.get(tokenId);
}

export function clearAllBuckets(): void {
  buckets.clear();
}
