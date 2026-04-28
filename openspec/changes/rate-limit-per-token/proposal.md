# Proposal: rate-limit-per-token

> **Phase:** sdd-propose
> **Project:** Nexus AI Gateway (Bun + TypeScript, Turso/LibSQL)
> **Date:** 2026-04-28
> **Predecessor:** `openspec/changes/rate-limit-per-token/explore.md`

---

## Intent

Add a **per-token request rate limit** to close the gap between the existing **per-provider circuit breaker** (failure-driven, too coarse) and the **monthly token quota** (billing-driven, too slow to react). Today a leaked or misbehaving token can drain the monthly quota in minutes; the operator only learns when `QUOTA_EXCEEDED` fires or upstream bills arrive.

Two recent commits make this change cheap to land:
- `fe74f79` — structured pino logger + prom-client metrics (observability already in place).
- `80c420b` — `error_code` enum with `RATE_LIMITED` already reserved (response shape already in place).

A per-token, requests-per-minute cap is the missing fast-feedback layer that lets the operator notice and revoke abusive tokens **before** the monthly bucket drains.

---

## Scope

### In Scope (the 13 commitments)

#### Algorithm & runtime
1. **Algorithm:** classic **token bucket** — `{ tokens: number, lastRefillMs: number }` per token, **lazy refill** computed on each consume call (no background timers). Time source: `performance.now()` (monotonic) — never `Date.now()`.
2. **Granularity:** **per-token only** for v1. Per-IP and per-token+model are deferred (see Out of Scope).
3. **Persistence:** **in-memory only** for v1. Bucket state is per Bun process. **Documented caveats:** (a) every deploy/restart hands every token a fresh full bucket; (b) the gateway is **not safe to run multi-instance** under this design — N instances → effective limit = N × cap.
4. **What counts as a request:** **1 request = 1 bucket consumption**, charged at request entry. Streaming chat completions do **not** continuously charge — one consume on connect, no per-chunk decrement, no refund on disconnect.

#### Integration points
5. **Master key + dashboard session bypass** the rate limiter unconditionally (`authContext.type === 'master'`). The limiter only runs when `authContext.type === 'token'` AND the path matches `/v1/*`. `/admin/*` is master-only and de-facto unlimited.
10. **Order of checks per request:** auth → monthly quota → rate limit → routing. A token over both quota and rate sees `QUOTA_EXCEEDED` (preserves the tested code path; both are 429 with distinct `error_code`s, so clients can branch).

#### Response contract
6. **Headers on every authed `/v1/*` response (200 and 429):**
   - `X-RateLimit-Limit` — the effective per-minute capacity for this token.
   - `X-RateLimit-Remaining` — integer floor of current bucket level.
   - `X-RateLimit-Reset` — **seconds-until-full-refill** (relative integer, NOT a Unix timestamp — easier for clients with skewed clocks).
   - On 429s only: `Retry-After` — integer seconds until at least 1 token is available (RFC 9110 §10.2.3 delta-seconds form).
7. **429 response body:** uses the existing `errorResponse(status, code, message, options)` helper from `errors.ts`. No changes to `errors.ts`. Body shape:
   ```json
   {
     "error": {
       "code": "RATE_LIMITED",
       "message": "Rate limit exceeded for this token. Retry in N seconds.",
       "retry_after_seconds": <int>,
       "limit": <int>,
       "remaining": 0,
       "window": "minute"
     }
   }
   ```

#### Configuration
8. **Defaults (env-overridable, no code change to retune):**
   - `RATE_LIMIT_PER_MINUTE_DEFAULT=60`
   - `RATE_LIMIT_BURST_DEFAULT=20`
   - Per-token DB overrides are **nullable** — NULL means "fall back to env default".
   - Soft-disable kill switch: `RATE_LIMIT_DISABLED=1` skips the entire check (rollback lever, see below).
9. **Schema** — three nullable columns added to `gateway_tokens` via the existing `try { ALTER TABLE … ADD COLUMN … } catch {}` migration pattern (`services/database.ts:48-53`):
   ```sql
   ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER;        -- NULL = use default
   ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER;             -- NULL = use default
   ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0;  -- INTEGER 0/1 (LibSQL has no native BOOLEAN)
   ```

#### Admin & ops
11. **Admin endpoints (`/admin/tokens`):** `POST` (create), `GET` (list), `PATCH /:id` (update) all accept and surface `ratePerMinute`, `rateBurst`, `rateLimitDisabled`. UI policy: **blank input = "use default"**, explicit number overrides. No new admin endpoint to "reset bucket" — buckets refill naturally.

#### Observability
12. **Metrics:** new counter
    ```
    gateway_ratelimit_total{token_label, outcome}
    ```
    where `outcome ∈ {allowed, rejected}`. Cardinality bounded by operator-controlled token count (<50). **No queue metric** — v1 rejects, never queues.
13. **Logging:** every **rejection** logs at `info` with `tag: 'RateLimit'`, `token_id`, `token_label`, `limit`, `burst`, `retry_after_seconds`. The **allowed** path is hot — log only at `debug` to avoid 5x'ing operational log volume.

### Out of Scope (deferred, document explicitly)

- **Per-IP rate limiting** (for unauth/`/health` flooding) — separate change; needs `X-Forwarded-For` trust model.
- **Per-token + per-model granularity** (to align with upstream provider per-model caps) — revisit if we observe specific upstream-model exhaustion patterns.
- **Persistence of bucket state** (Turso-backed or Redis) — required for horizontal scale; not needed for current single-VPS deployment.
- **Queueing / shaping** (delay instead of reject) — clean 429 with `Retry-After` is OpenAI-compatible and what every popular client lib already understands.
- **Concurrency caps** (e.g., max 3 concurrent streams per token) — separate concern; tracked by existing `activeStreams` gauge but not enforced.
- **LLM-tokens-out / tokens-in-based rate limiting** — `monthly_quota_tokens` already prices LLM tokens. Don't double-charge.
- **Distributed-leak defense** (many tokens abused at once draining shared upstream) — provider-account-level concern.

---

## Approach

A new module **`services/rate-limiter.ts`** owns the in-memory bucket store. Public surface:

```ts
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;          // effective per-minute capacity
  remaining: number;      // floor(currentTokens)
  resetSeconds: number;   // ceil((capacity - currentTokens) / refillPerSec)
  retryAfterSeconds: number; // 0 if allowed; ceil((1 - tokens) / refillPerSec) on reject
}

export function checkRateLimit(
  tokenId: number,
  config: { perMinute: number; burst: number; disabled: boolean }
): RateLimitDecision;
```

**Why a separate file:**
- **Testability** — the bucket math (refill/consume) is pure and deterministic given an injectable clock. Unit tests don't need to spin up an HTTP server.
- **Future swap** — when (if) we move to Turso-backed or Redis, only this file changes. The call site in `index.ts` stays a one-liner.
- **Locality** — keeps `index.ts` (already 1900+ lines) from accreting another concern.

The call site lives in `index.ts` immediately after `authContext` is finalized (after line ~1469) and before any path-specific handler runs. The rate limiter resolves effective config from `authContext.rateLimit` (filled at auth time from the DB row + env defaults).

`AuthContext` for `type: 'token'` is extended to carry resolved limits forward, so the rate-limit step does **not** re-read the DB row:

```ts
| { type: 'token'; tokenId: number; label: string; monthlyQuota: number | null; used: number;
    rateLimit: { perMinute: number; burst: number; disabled: boolean } }
```

Headers are appended via the existing `errorResponse` `options.headers` hook on 429s, and via a small `withRateLimitHeaders(response, decision)` helper for 200s.

---

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `services/rate-limiter.ts` | **New** | In-memory `Map<tokenId, BucketState>`, pure refill/consume math, injectable clock for tests. |
| `services/database.ts` | Modified | Migration (3 `ALTER TABLE` adds), update `rowToGatewayToken`, `findGatewayTokenBySecret`, `listGatewayTokens`, `createGatewayToken`, `updateGatewayToken`. |
| `index.ts` | Modified | (a) Resolve `rateLimit` config in the token-auth branch; (b) call `checkRateLimit` after auth, before handlers; (c) attach headers to authed `/v1/*` responses; (d) extend `/admin/tokens` POST/GET/PATCH to accept and surface new fields. |
| `types.ts` | Modified | Extend `GatewayToken` with 3 new fields; extend `AuthContext['token']` with `rateLimit` sub-object. |
| `metrics.ts` | Modified | Add `gateway_ratelimit_total` counter. |
| `errors.ts` | **No change** | `RATE_LIMITED` already in the enum; `errorResponse` already supports header injection. |
| `dashboard.html` | Modified | Admin token modal: 3 new form inputs (per-minute, burst, disabled checkbox), blank = default. |
| `README.md` | Modified | Document the rate limiter, headers, env vars, restart-resets-buckets caveat, and how to read the new error. |

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| **Restart resets all buckets** — every deploy hands every token a fresh full bucket. | High (deploys happen) | Low (one burst per deploy; circuit breaker is the backstop) | Document explicitly in README and proposal. Acceptable for v1. |
| **Multi-instance unsafe** — if/when scaled horizontally, effective cap = N × configured cap per token. | Low today (single VPS) | Medium if scaled | Document as a known limitation. Migration path: switch `services/rate-limiter.ts` to Turso-backed atomic counter or Redis. |
| **Clock skew via `Date.now()`** would cause negative elapsed → undefined refill behavior. | Low | Medium (intermittent over-allow) | Use `performance.now()` (monotonic). Clamp `Math.max(0, elapsed)` defensively. |
| **Header bloat on every 200 response** (~80 extra bytes). | High (every request) | Negligible | Document. If a customer ever complains, an env flag can suppress headers on 200s. |
| **Dashboard admin-token modal layout breaks** when 3 new form fields are added to an already-dense modal. | Medium | Low (UX, not correctness) | Group the 3 fields under a collapsible "Rate limit" section in the modal; design pass during sdd-design. |
| **Client retry libs that ignore `error_code` and only see "429"** may retry-storm against a rate-limited token. | Medium | Medium | `Retry-After` is honored by every standard retry library; document in changelog. The `error_code` field already disambiguates from `QUOTA_EXCEEDED`. |
| **Memory growth from `Map<tokenId, …>`** unbounded. | Low (operator controls token count) | Low (~64 B per token; 1000 tokens = 64 KB) | Document. Optional follow-up: LRU-evict full+idle buckets after 1h. |

---

## Rollback Plan

**Soft rollback (no code revert):** set env `RATE_LIMIT_DISABLED=1`. The handler short-circuits the rate-limit check entirely; `gateway_ratelimit_total` stops incrementing; headers are no longer attached. Restart the gateway and rate limiting is fully disabled while keeping schema and code in place.

**Code revert:** revert the merge commit. The 3 new columns remain on `gateway_tokens` (harmless — they're nullable config fields, never read after revert).

**Schema revert (only if needed):** `ALTER TABLE gateway_tokens DROP COLUMN rate_limit_per_minute;` (and the other two). This is data-destructive but tolerable since the columns are pure configuration — no operational state lives in them. Order: revert code first, then drop columns, never the reverse.

---

## Dependencies

- No new runtime dependencies. `prom-client`, `pino`, and the LibSQL client are already in the gateway.
- Bun runtime is assumed to provide `performance.now()` (it does, since Bun 0.x).
- Requires `errorResponse` in `errors.ts` to accept extra headers — **already supported** at `errors.ts:62-64`.

---

## Success Criteria

- [ ] A token configured with `rate_limit_per_minute=60, rate_limit_burst=20` allows up to 20 immediate requests, then 1/sec steady-state, then returns `429 RATE_LIMITED` with `Retry-After` and `X-RateLimit-*` headers.
- [ ] A token with `rate_limit_disabled=1` is never throttled regardless of rate.
- [ ] A token with all three rate columns NULL uses the env defaults (60/20).
- [ ] Master key requests to `/v1/*` are never rate-limited (verified by sustained `>200 rpm` script).
- [ ] `/admin/tokens` GET surfaces the 3 new fields; POST and PATCH accept them; blank input → NULL → default at runtime.
- [ ] Prometheus exposes `gateway_ratelimit_total{token_label="x", outcome="allowed|rejected"}` and the counters tick correctly under a load test.
- [ ] A token over both monthly quota AND rate limit receives `QUOTA_EXCEEDED` (not `RATE_LIMITED`) — confirms the documented check order.
- [ ] Setting `RATE_LIMIT_DISABLED=1` and restarting the gateway disables the entire feature without code changes (rollback lever verified).
- [ ] Migration on an existing populated DB is idempotent: running on a fresh DB and on an already-migrated DB both succeed without data loss.
- [ ] README documents the env vars, headers, error shape, and the restart-resets-buckets caveat.
