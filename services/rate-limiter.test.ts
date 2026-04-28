import { describe, test, expect, beforeEach } from 'bun:test';
import {
  checkAndConsume,
  clearAllBuckets,
  configFromToken,
  getBucketState,
  withRateLimitHeaders,
  type BucketConfig,
  type BucketDecision,
} from './rate-limiter';
import type { GatewayToken } from '../types';

const baseToken: GatewayToken = {
  id: 1,
  label: 'test-token',
  secret: 'secret',
  active: 1,
  monthly_quota_tokens: null,
  used_tokens_current_month: 0,
  quota_reset_at: null,
  created_at: new Date(0).toISOString(),
  last_used_at: null,
  notes: null,
  rate_limit_per_minute: null,
  rate_limit_burst: null,
  rate_limit_disabled: 0,
};

function makeToken(overrides: Partial<GatewayToken>): GatewayToken {
  return { ...baseToken, ...overrides };
}

function drainBucket(tokenId: number, config: BucketConfig, count: number, now: number): void {
  for (let i = 0; i < count; i++) {
    checkAndConsume(tokenId, 'test', config, now);
  }
}

describe('rate-limiter unit tests', () => {
  beforeEach(() => {
    clearAllBuckets();
  });

  describe('bucket math', () => {
    test('fresh bucket allows burst requests', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      for (let i = 0; i < 20; i++) {
        const decision = checkAndConsume(1, 'test', config, now);
        expect(decision.allowed).toBe(true);
      }
    });

    test('burst exhaustion rejects the next request', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(2, config, 20, now);
      const decision = checkAndConsume(2, 'test', config, now);

      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('rejected');
    });

    test('refill after 1s allows a request', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(3, config, 20, now);
      const decision = checkAndConsume(3, 'test', config, now + 1000);

      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(0);
    });

    test('fractional refill at 500ms remains rejected', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(4, config, 20, now);
      const decision = checkAndConsume(4, 'test', config, now + 500);

      expect(decision.allowed).toBe(false);
      const state = getBucketState(4);
      expect(state?.tokens).toBeCloseTo(0.5, 5);
    });

    test('fractional refill at 1500ms allows once, then rejects', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(5, config, 20, now);
      const first = checkAndConsume(5, 'test', config, now + 1500);
      const second = checkAndConsume(5, 'test', config, now + 1500);

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
    });

    test('refill clamps at burst capacity', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(6, config, 20, now);
      const decision = checkAndConsume(6, 'test', config, now + 60000);

      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(19);
    });

    test('non-monotonic time does not over-refill', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };

      checkAndConsume(7, 'test', config, 1000);
      checkAndConsume(7, 'test', config, 900);

      const state = getBucketState(7);
      expect(state?.tokens).toBe(18);
    });

    test('retryAfterSeconds and resetSeconds follow expected math on rejection', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: false };
      const now = 0;

      drainBucket(8, config, 20, now);
      const decision = checkAndConsume(8, 'test', config, now);

      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSeconds).toBe(1);
      expect(decision.resetSeconds).toBe(20);
      expect(decision.remaining).toBe(0);
    });
  });

  describe('config resolution', () => {
    const defaults = { perMinute: 60, burst: 20, killSwitch: false };

    test('null columns fall back to env defaults', () => {
      const token = makeToken({
        rate_limit_per_minute: null,
        rate_limit_burst: null,
        rate_limit_disabled: 0,
      });

      const config = configFromToken(token, defaults);

      expect(config).toEqual({ perMinute: 60, burst: 20, disabled: false });
    });

    test('per-token override wins over defaults', () => {
      const token = makeToken({
        rate_limit_per_minute: 30,
        rate_limit_burst: 10,
        rate_limit_disabled: 0,
      });

      const config = configFromToken(token, defaults);

      expect(config).toEqual({ perMinute: 30, burst: 10, disabled: false });
    });

    test('per-token disabled flag sets disabled', () => {
      const token = makeToken({ rate_limit_disabled: 1 });

      const config = configFromToken(token, defaults);

      expect(config.disabled).toBe(true);
    });

    test('kill switch defaults force disabled', () => {
      const token = makeToken({
        rate_limit_per_minute: null,
        rate_limit_burst: null,
        rate_limit_disabled: 0,
      });

      // Kill switch env is read at module load; this test validates the config contract only.
      const config = configFromToken(token, { perMinute: 60, burst: 20, killSwitch: true });

      expect(config.disabled).toBe(true);
    });
  });

  describe('disabled flag behavior', () => {
    test('disabled config bypasses and does not create bucket state', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: true };

      const decision = checkAndConsume(9, 'test', config, 0);

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('bypassed');
      expect(getBucketState(9)).toBeUndefined();
    });

    test('repeated disabled calls remain bypassed', () => {
      const config: BucketConfig = { perMinute: 60, burst: 20, disabled: true };

      const first = checkAndConsume(10, 'test', config, 0);
      const second = checkAndConsume(10, 'test', config, 0);

      expect(first.outcome).toBe('bypassed');
      expect(second.outcome).toBe('bypassed');
      expect(getBucketState(10)).toBeUndefined();
    });
  });

  describe('atomicity', () => {
    test('race for last token allows exactly one', async () => {
      const config: BucketConfig = { perMinute: 60, burst: 2, disabled: false };
      const now = 0;

      checkAndConsume(11, 'test', config, now);

      const results = await Promise.all([
        Promise.resolve(checkAndConsume(11, 'test', config, now)),
        Promise.resolve(checkAndConsume(11, 'test', config, now)),
        Promise.resolve(checkAndConsume(11, 'test', config, now)),
      ]);

      const allowed = results.filter(result => result.allowed).length;
      const rejected = results.filter(result => !result.allowed).length;

      expect(allowed).toBe(1);
      expect(rejected).toBe(2);
    });
  });

  describe('streaming semantics', () => {
    test('no refund on abort: second consume rejected', () => {
      const config: BucketConfig = { perMinute: 60, burst: 1, disabled: false };
      const now = 0;

      const first = checkAndConsume(12, 'test', config, now);
      const second = checkAndConsume(12, 'test', config, now);

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
    });
  });

  describe('rate-limit headers helper', () => {
    test('clones response and attaches headers', async () => {
      const decision: BucketDecision = {
        allowed: true,
        remaining: 5,
        resetSeconds: 10,
        retryAfterSeconds: 0,
        limit: 60,
        outcome: 'allowed',
      };
      const resp = new Response('ok', { status: 201, headers: { 'Content-Type': 'text/plain' } });

      const wrapped = withRateLimitHeaders(resp, decision);

      expect(wrapped).not.toBe(resp);
      expect(wrapped.status).toBe(201);
      expect(wrapped.headers.get('Content-Type')).toBe('text/plain');
      expect(wrapped.headers.get('X-RateLimit-Limit')).toBe('60');
      expect(wrapped.headers.get('X-RateLimit-Remaining')).toBe('5');
      expect(wrapped.headers.get('X-RateLimit-Reset')).toBe('10');
      await expect(wrapped.text()).resolves.toBe('ok');
    });
  });
});
