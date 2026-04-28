# Spec: rate-limit-per-token

> **Phase:** sdd-spec
> **Project:** Nexus AI Gateway (Bun + TypeScript, Turso/LibSQL)
> **Date:** 2026-04-28
> **Predecessor:** `openspec/changes/rate-limit-per-token/proposal.md`
> **Format:** Given/When/Then with RFC 2119 keywords (MUST, SHALL, SHOULD, MAY).
> **Audience:** This document is the test plan. Each scenario SHOULD be implementable as a single automated test.

This spec covers the gateway domain (auth + request handling). No prior `openspec/specs/<domain>/spec.md` exists for this domain, so this is a NEW spec rather than a delta.

---

## 1. Functional Requirements (Token Bucket Behavior)

### Requirement 1.1: Token bucket per token, lazy refill

The gateway MUST maintain a per-token bucket state of the form `{ tokens: number, lastRefillMs: number }`, refilled lazily on each consume call. Refill MUST use a monotonic clock source. The gateway MUST NOT use background timers to drive refill.

#### Scenario 1.1.1: Steady-state allow under cap

- GIVEN a token configured with `rate_limit_per_minute=60` and `rate_limit_burst=20`, with a fresh full bucket
- WHEN the token sends 20 requests within 100 ms
- THEN the gateway MUST return non-429 status (i.e. allow the rate-limit check to pass) for all 20 requests

#### Scenario 1.1.2: Burst exhaustion triggers 429

- GIVEN a token with `rate_limit_per_minute=60` and `rate_limit_burst=20`, fresh full bucket
- WHEN the token sends 21 requests within 1 second
- THEN the gateway MUST allow the first 20 requests
- AND the gateway MUST reject the 21st request with HTTP `429`
- AND the 429 response body MUST include `error.code = "RATE_LIMITED"`

#### Scenario 1.1.3: Refill restores capacity over time

- GIVEN a token with `rate_limit_per_minute=60`, `rate_limit_burst=20`, and bucket emptied to 0 tokens
- WHEN exactly 1.0 second of monotonic time elapses with no requests
- THEN the bucket MUST contain at least 1 (and at most 2) consumable tokens upon next consume call

#### Scenario 1.1.4: Fractional refill is held but only integer tokens are consumable

- GIVEN a token with `rate_limit_per_minute=60` (refill rate = 1 token / sec), bucket emptied to 0
- WHEN 1.5 seconds elapse and a single request arrives
- THEN the gateway MUST allow that request (1 integer token available)
- AND the post-consume bucket MUST hold 0.5 fractional tokens (verifiable through `X-RateLimit-Remaining: 0` and the next request requiring < 0.5s wait)

#### Scenario 1.1.5: Refill cannot exceed burst capacity

- GIVEN a token with `rate_limit_burst=20` and bucket already at 20 tokens
- WHEN 60 seconds elapse with no consume calls
- THEN the bucket MUST still be at 20 tokens (never higher)

#### Scenario 1.1.6: Defensive clamp on non-monotonic delta

- GIVEN a token with any bucket state and an `elapsedMs` computed as negative (e.g. due to a clock-source anomaly)
- WHEN refill is computed
- THEN the gateway MUST clamp `elapsedMs` to `Math.max(0, elapsedMs)` so refill cannot decrement the bucket
- AND the post-clamp bucket MUST NOT exceed burst capacity

### Requirement 1.2: One request equals one token

The gateway MUST charge exactly **one** bucket token per inbound `/v1/*` request from a token-authed caller. No request type SHALL charge zero tokens, and no request type SHALL charge more than one.

#### Scenario 1.2.1: Non-streaming chat completion charges 1

- GIVEN a token with 5 tokens remaining in its bucket
- WHEN the token sends a single non-streaming `/v1/chat/completions` POST
- THEN exactly 1 token MUST be consumed
- AND the response `X-RateLimit-Remaining` header MUST equal 4

#### Scenario 1.2.2: Streaming chat completion charges exactly 1 at start

- GIVEN a token with 1 token remaining in its bucket
- WHEN the token initiates a streaming `/v1/chat/completions` request that produces 50 SSE chunks
- THEN exactly 1 token MUST be consumed at request entry
- AND the bucket MUST NOT be charged again per chunk
- AND the response MUST be allowed and stream to completion

#### Scenario 1.2.3: Stream client-abort does NOT refund

- GIVEN a token with 0 tokens remaining after starting one stream
- WHEN the client aborts the stream after 100 ms
- THEN the bucket MUST NOT be incremented (no refund)
- AND a follow-up immediate request MUST be rate-limited as if the aborted stream had completed normally

### Requirement 1.3: Concurrency is atomic per token

The gateway MUST guarantee that two concurrent requests for the same `tokenId` cannot both pass the rate-limit check when only one bucket token is available. Atomicity SHALL be provided by synchronous mutation within a single JS event-loop microtask. The gateway MUST NOT introduce locks, mutexes, or async-IO between bucket read and bucket write.

#### Scenario 1.3.1: Race for last token

- GIVEN a token with exactly 1 token remaining in its bucket
- WHEN two requests for that token arrive on the same Bun process within the same event-loop tick
- THEN exactly one MUST be allowed and exactly one MUST receive 429 `RATE_LIMITED`

---

## 2. Configuration Requirements

### Requirement 2.1: Env defaults

The gateway MUST read the following env vars on startup; missing or non-integer values MUST fall back to documented defaults.

| Env var | Default | Semantics |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE_DEFAULT` | `60` | Default refill rate in requests per minute |
| `RATE_LIMIT_BURST_DEFAULT` | `20` | Default bucket capacity |
| `RATE_LIMIT_DISABLED` | unset (= enabled) | If `1`, the rate-limit check is skipped globally |

#### Scenario 2.1.1: Defaults applied to a token with all NULL columns

- GIVEN env `RATE_LIMIT_PER_MINUTE_DEFAULT=60` and `RATE_LIMIT_BURST_DEFAULT=20`
- AND a `gateway_tokens` row with `rate_limit_per_minute=NULL`, `rate_limit_burst=NULL`, `rate_limit_disabled=0`
- WHEN that token authenticates
- THEN the resolved effective config MUST be `{ perMinute: 60, burst: 20, disabled: false }`

#### Scenario 2.1.2: Per-token override wins over env

- GIVEN env defaults `60`/`20`
- AND a `gateway_tokens` row with `rate_limit_per_minute=30`, `rate_limit_burst=10`
- WHEN that token authenticates
- THEN the resolved effective config MUST be `{ perMinute: 30, burst: 10, disabled: false }`

#### Scenario 2.1.3: Per-token disable flag

- GIVEN a `gateway_tokens` row with `rate_limit_disabled=1`
- WHEN that token sends 1000 requests in 1 second
- THEN no request MUST be rejected by the rate limiter
- AND the gateway MUST NOT include `X-RateLimit-*` headers on those responses

### Requirement 2.2: Database schema

The gateway MUST add three nullable columns to `gateway_tokens` using the existing additive `try { ALTER TABLE … ADD COLUMN … } catch {}` pattern in `services/database.ts`:

```sql
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER;             -- NULL = use env default
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER;                  -- NULL = use env default
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0;  -- 0/1
```

Reads from `gateway_tokens` MUST surface these three fields on `GatewayToken`.

#### Scenario 2.2.1: Migration is idempotent on a populated DB

- GIVEN an existing `gateway_tokens` table without rate-limit columns
- WHEN the gateway starts up for the first time after the change
- THEN the migration MUST add `rate_limit_per_minute INTEGER`, `rate_limit_burst INTEGER`, and `rate_limit_disabled INTEGER NOT NULL DEFAULT 0`
- AND existing rows MUST remain valid (NULL for the two nullable columns; 0 for the disabled flag)
- AND a subsequent restart MUST NOT raise a migration error (each `ALTER` is wrapped in its own try/catch)

#### Scenario 2.2.2: Fresh DB also passes migration

- GIVEN a brand-new empty database
- WHEN the gateway starts up
- THEN the `gateway_tokens` table MUST exist with the three new columns present from the start (or via the same try/catch ALTER chain)

---

## 3. API Contract Requirements

### Requirement 3.1: `X-RateLimit-*` headers on token-authed `/v1/*` responses

For every response to a token-authed `/v1/*` request, regardless of HTTP status (200, 4xx, 5xx), the gateway MUST attach the following headers:

- `X-RateLimit-Limit`: integer, the effective per-minute capacity for this token (= `perMinute`)
- `X-RateLimit-Remaining`: integer, `Math.floor(currentTokens)` after the consume that produced this response
- `X-RateLimit-Reset`: integer, **seconds-until-bucket-is-full**, computed as `Math.ceil((burst - currentTokens) / refillPerSec)`. This is a delta in seconds, NOT a Unix timestamp.

#### Scenario 3.1.1: Headers on 200 success

- GIVEN a token with `rate_limit_per_minute=60`, `rate_limit_burst=20`, and 14 tokens remaining after a successful consume
- WHEN that request returns 200
- THEN the response MUST include `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining: 14`, and `X-RateLimit-Reset: <int>` where `<int>` equals `Math.ceil((20 - 14) / 1)` = `6`

#### Scenario 3.1.2: Headers on 4xx (e.g. 400 bad request that still passed rate limit)

- GIVEN the same token with 14 tokens remaining after consume
- WHEN the underlying handler returns 400 due to a malformed body
- THEN the 400 response MUST still include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`

#### Scenario 3.1.3: Headers on 5xx upstream failures

- GIVEN the same token with 14 tokens remaining after consume
- WHEN the upstream provider returns 502 and the gateway forwards a 502
- THEN the 502 response MUST still include the three `X-RateLimit-*` headers

### Requirement 3.2: 429 response body shape

When the gateway rejects a request due to an empty bucket, it MUST return HTTP `429` produced via the existing `errorResponse` helper, with body shape exactly:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "<human-readable message including retry-after seconds>",
    "retry_after_seconds": <int>,
    "limit": <int>,
    "remaining": 0,
    "window": "minute"
  }
}
```

The 429 response MUST also include the standard `X-RateLimit-*` headers AND a `Retry-After` header in delta-seconds form (RFC 9110 §10.2.3).

#### Scenario 3.2.1: 429 body is well-formed

- GIVEN a token with bucket emptied and refill rate `1 token/sec`
- WHEN the token sends a request
- THEN the response status MUST be `429`
- AND the body `error.code` MUST equal `"RATE_LIMITED"`
- AND the body MUST include `retry_after_seconds: 1`, `limit: 60`, `remaining: 0`, `window: "minute"`
- AND the response headers MUST include `Retry-After: 1`
- AND the response headers MUST include `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset: 20`

#### Scenario 3.2.2: `Retry-After` value monotonically usable

- GIVEN a 429 response with `Retry-After: N`
- WHEN the client waits exactly `N` seconds and retries the same token
- THEN the gateway MUST allow the retry (≥ 1 token has refilled)

#### Scenario 3.2.3: `Retry-After` is delta-seconds, not a date

- GIVEN any 429 from the rate limiter
- WHEN inspecting the `Retry-After` header
- THEN the value MUST be an integer ≥ 1
- AND the value MUST NOT be an HTTP-date string

---

## 4. Integration Order Requirements

### Requirement 4.1: Order of checks

For every inbound HTTP request, the gateway MUST evaluate guards in the following order, short-circuiting on the first failure:

1. **Auth**: resolve to `authContext` of `master` | `token` | `none`. On failure, return `401` (or `403` for invalid master key as today). MUST NOT consume a bucket.
2. **Monthly quota** (token-authed only, `/v1/*` only): if monthly quota is exhausted, return `429` with `error.code = "QUOTA_EXCEEDED"`. MUST NOT consume the rate-limit bucket.
3. **Rate limit** (token-authed only, `/v1/*` only, unless `RATE_LIMIT_DISABLED=1` or `rate_limit_disabled=1` for the token): if bucket is empty, return `429` with `error.code = "RATE_LIMITED"`.
4. **Routing & handler**: provider routing, retries, streaming.

#### Scenario 4.1.1: Auth failure does not consume bucket

- GIVEN a request with a malformed `Authorization` header
- WHEN it arrives
- THEN the gateway MUST return `401` BEFORE looking up any token bucket
- AND no bucket state MUST change

#### Scenario 4.1.2: Quota wins over rate limit

- GIVEN a token whose monthly quota is exhausted
- AND whose rate-limit bucket is also empty
- WHEN the token sends a request
- THEN the response MUST be `429` with `error.code = "QUOTA_EXCEEDED"` (NOT `RATE_LIMITED`)
- AND the rate-limit bucket MUST NOT be consumed (no further decrement)

#### Scenario 4.1.3: Rate-limit applies only after quota check passes

- GIVEN a token within monthly quota but with empty rate-limit bucket
- WHEN the token sends a request
- THEN the response MUST be `429` with `error.code = "RATE_LIMITED"`

#### Scenario 4.1.4: Rate-limit not applied to `/admin/*`

- GIVEN a master-keyed request to `/admin/tokens`
- WHEN it arrives
- THEN the rate-limit check MUST NOT run
- AND the response MUST NOT include `X-RateLimit-*` headers

#### Scenario 4.1.5: Rate-limit not applied to public paths

- GIVEN an unauthenticated request to `/health`
- WHEN it arrives
- THEN the rate-limit check MUST NOT run
- AND the response MUST NOT include `X-RateLimit-*` headers

#### Scenario 4.1.6: 404 paths do not consume bucket

- GIVEN a token-authed request to a non-existent path (e.g. `/v1/does-not-exist`)
- WHEN it arrives
- THEN the gateway MUST return 404 without consuming a rate-limit token (the rate-limit middleware runs before route resolution only for known `/v1/*` routes; unknown paths short-circuit to 404)
- AND no `X-RateLimit-*` headers MUST be attached

> **Implementation note** for design phase: route resolution MUST occur such that 404 responses for unknown paths do not pass through the bucket consume. If the architecture requires consume-before-routing, this scenario MUST be revisited.

---

## 5. Bypass Requirements

### Requirement 5.1: Master key bypass

Requests where `authContext.type === 'master'` MUST bypass the rate-limit check unconditionally and MUST NOT have `X-RateLimit-*` headers attached.

#### Scenario 5.1.1: Master key under sustained high rate

- GIVEN a request authenticated with the master key
- WHEN the master key sends 1000 requests in 1 second
- THEN no request MUST receive `429 RATE_LIMITED`
- AND no response MUST include `X-RateLimit-*` headers

### Requirement 5.2: Dashboard session bypass

Requests where `authContext.type === 'master'` due to dashboard session HMAC (i.e. logged-in admin browsing) MUST also bypass per Requirement 5.1. The rate limiter MUST NOT distinguish between bearer master-key and session-based master access.

#### Scenario 5.2.1: Dashboard session under high rate

- GIVEN a logged-in dashboard session calling `/admin/tokens` repeatedly
- WHEN it sends 200 requests in 10 seconds
- THEN no request MUST be rate-limited
- AND no response MUST include `X-RateLimit-*` headers

### Requirement 5.3: Per-token disable flag

Requests where the token row has `rate_limit_disabled=1` MUST bypass the rate-limit check unconditionally and MUST NOT have `X-RateLimit-*` headers attached. (Header omission distinguishes "disabled per-token" from "headed but unlimited" so operators can verify their config from response inspection.)

#### Scenario 5.3.1: Disabled token is never throttled

- GIVEN a token with `rate_limit_disabled=1`
- WHEN it sends 1000 requests in 1 second
- THEN no request MUST receive `429 RATE_LIMITED`
- AND no response MUST include `X-RateLimit-*` headers

### Requirement 5.4: Global kill switch

When env `RATE_LIMIT_DISABLED=1`, the gateway MUST skip the rate-limit check entirely on every request, MUST NOT increment the metric counter, and MUST NOT attach `X-RateLimit-*` headers.

#### Scenario 5.4.1: Kill switch on

- GIVEN env `RATE_LIMIT_DISABLED=1` is set at startup
- WHEN any token-authed request arrives at `/v1/*`
- THEN the rate-limit check MUST be skipped
- AND `X-RateLimit-*` headers MUST NOT be attached
- AND `gateway_ratelimit_total` MUST NOT increment for this request

#### Scenario 5.4.2: Kill switch off (default)

- GIVEN env `RATE_LIMIT_DISABLED` is unset OR set to anything other than `1`
- WHEN any token-authed request arrives at `/v1/*`
- THEN the rate-limit check MUST run normally

---

## 6. Observability Requirements

### Requirement 6.1: Metric counter

The gateway MUST register a Prometheus counter named `gateway_ratelimit_total` with two labels:

- `token_label`: human-readable label of the token (NOT the secret, NOT the id)
- `outcome`: one of `"allowed"` or `"rejected"`

The counter MUST increment exactly once per rate-limit decision against a token (i.e. once per request that the rate-limit check evaluated, not skipped via bypass).

#### Scenario 6.1.1: Allowed increments allowed

- GIVEN a token labeled `"alice"` with capacity remaining
- WHEN the token sends 1 successful request
- THEN `gateway_ratelimit_total{token_label="alice", outcome="allowed"}` MUST increment by 1
- AND `gateway_ratelimit_total{token_label="alice", outcome="rejected"}` MUST NOT change

#### Scenario 6.1.2: Rejected increments rejected

- GIVEN a token labeled `"alice"` with bucket empty
- WHEN the token sends 1 request that hits 429
- THEN `gateway_ratelimit_total{token_label="alice", outcome="rejected"}` MUST increment by 1
- AND `gateway_ratelimit_total{token_label="alice", outcome="allowed"}` MUST NOT change

#### Scenario 6.1.3: Bypass paths do NOT increment

- GIVEN a master-keyed request OR a token with `rate_limit_disabled=1` OR env `RATE_LIMIT_DISABLED=1`
- WHEN the request is processed
- THEN neither `outcome="allowed"` nor `outcome="rejected"` MUST increment for that request

### Requirement 6.2: Logging on rejection

On every rate-limit rejection, the gateway MUST emit a structured pino log entry at level `info` containing the fields:

| Field | Type | Required |
|---|---|---|
| `tag` | string equal to `"RateLimit"` | yes |
| `token_id` | integer | yes |
| `token_label` | string | yes |
| `limit` | integer (effective `perMinute`) | yes |
| `burst` | integer (effective `burst`) | yes |
| `retry_after_seconds` | integer | yes |

#### Scenario 6.2.1: Reject log fields

- GIVEN a token with bucket empty
- WHEN it is rejected
- THEN a single log entry MUST be emitted at level `info` with all six fields present and correctly populated

### Requirement 6.3: Logging on allowed (hot path)

The gateway MUST NOT log allowed requests at level `info` or higher. The gateway MAY log allowed requests at level `debug`.

#### Scenario 6.3.1: Allowed path silent at info

- GIVEN logger configured at level `info`
- WHEN 100 allowed requests pass the rate-limit check
- THEN zero `RateLimit`-tagged log entries MUST be emitted

---

## 7. Admin Endpoint Requirements

### Requirement 7.1: `POST /admin/tokens` accepts new fields

The `POST /admin/tokens` endpoint MUST accept three additional optional fields in its JSON body:

- `ratePerMinute`: integer or null (null = use env default; absent = same as null)
- `rateBurst`: integer or null (null = use env default; absent = same as null)
- `rateLimitDisabled`: boolean (default `false`; persisted as `0`/`1`)

The created `gateway_tokens` row MUST persist these values (NULL for absent/null nullable fields, `0`/`1` for the disabled flag).

#### Scenario 7.1.1: POST with all rate fields

- GIVEN a master-keyed POST `/admin/tokens` with body `{ "label": "x", "ratePerMinute": 30, "rateBurst": 10, "rateLimitDisabled": false }`
- WHEN processed
- THEN the new row MUST have `rate_limit_per_minute=30`, `rate_limit_burst=10`, `rate_limit_disabled=0`
- AND the response JSON MUST surface `ratePerMinute: 30`, `rateBurst: 10`, `rateLimitDisabled: false`

#### Scenario 7.1.2: POST with rate fields omitted

- GIVEN a master-keyed POST `/admin/tokens` with body `{ "label": "x" }`
- WHEN processed
- THEN the new row MUST have `rate_limit_per_minute=NULL`, `rate_limit_burst=NULL`, `rate_limit_disabled=0`

#### Scenario 7.1.3: POST with explicit nulls (blank dashboard input)

- GIVEN a master-keyed POST `/admin/tokens` with body `{ "label": "x", "ratePerMinute": null, "rateBurst": null }`
- WHEN processed
- THEN the new row MUST have `rate_limit_per_minute=NULL` and `rate_limit_burst=NULL`
- AND that token at runtime MUST resolve to env defaults

### Requirement 7.2: `PATCH /admin/tokens/:id` updates the three fields

The `PATCH /admin/tokens/:id` endpoint MUST accept the same three optional fields as `POST` and MUST update the corresponding columns when present. Absent fields MUST NOT modify existing column values. Explicit `null` MUST clear the override (set the column to NULL).

#### Scenario 7.2.1: PATCH overrides existing values

- GIVEN an existing token row with `rate_limit_per_minute=60`, `rate_limit_burst=20`, `rate_limit_disabled=0`
- WHEN PATCH body `{ "ratePerMinute": 10 }` is processed
- THEN `rate_limit_per_minute` MUST become `10`
- AND `rate_limit_burst` and `rate_limit_disabled` MUST remain unchanged

#### Scenario 7.2.2: PATCH clears with null

- GIVEN an existing token row with `rate_limit_per_minute=10`
- WHEN PATCH body `{ "ratePerMinute": null }` is processed
- THEN `rate_limit_per_minute` MUST become NULL
- AND that token at runtime MUST resolve to the env default

#### Scenario 7.2.3: PATCH toggles disable flag

- GIVEN an existing token row with `rate_limit_disabled=0`
- WHEN PATCH body `{ "rateLimitDisabled": true }` is processed
- THEN `rate_limit_disabled` MUST become `1`
- AND that token MUST be bypassed by the rate limiter on its next request

### Requirement 7.3: `GET /admin/tokens` surfaces the three fields

`GET /admin/tokens` MUST include `ratePerMinute`, `rateBurst`, and `rateLimitDisabled` for every token in the response array. NULL columns MUST surface as JSON `null`. The `rate_limit_disabled` column MUST surface as a JSON boolean.

#### Scenario 7.3.1: GET shape

- GIVEN tokens with various rate-limit configurations including NULLs
- WHEN GET `/admin/tokens` is called
- THEN every element of the response array MUST contain `ratePerMinute`, `rateBurst`, and `rateLimitDisabled`
- AND NULL columns MUST be returned as JSON `null`
- AND `rate_limit_disabled=0` MUST be returned as `false`, `=1` as `true`

### Requirement 7.4: Dashboard form behavior

The dashboard token modal MUST provide form inputs for the three fields. Blank inputs MUST be submitted as JSON `null` (not as `0` or empty string). The disabled flag MUST be a checkbox mapping to JSON `true`/`false`.

#### Scenario 7.4.1: Blank input maps to null

- GIVEN a user opens the "create token" modal and leaves rate-per-minute blank
- WHEN the form is submitted
- THEN the POST body sent to the gateway MUST contain `"ratePerMinute": null` (or omit the field)
- AND the resulting DB row MUST have `rate_limit_per_minute=NULL`

#### Scenario 7.4.2: Numeric input persists

- GIVEN a user enters `30` into the rate-per-minute input
- WHEN the form is submitted
- THEN the POST body MUST contain `"ratePerMinute": 30`
- AND the resulting DB row MUST have `rate_limit_per_minute=30`

---

## 8. Migration Requirements

### Requirement 8.1: Additive ALTER TABLE migration

The schema migration MUST use the existing additive try/catch ALTER pattern in `services/database.ts` and MUST add exactly three columns:

```sql
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER;
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER;
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0;
```

Each ALTER MUST be wrapped in its own try/catch so re-running on an already-migrated DB is a no-op.

#### Scenario 8.1.1: First-run on existing DB

- GIVEN a `gateway_tokens` table without the three columns and N pre-existing rows
- WHEN the gateway starts up
- THEN the three columns MUST be present after startup
- AND all N pre-existing rows MUST remain valid (NULLs for the two override columns; `0` for the disabled flag)

#### Scenario 8.1.2: Idempotent re-run

- GIVEN a DB already migrated
- WHEN the gateway restarts
- THEN no migration error MUST be raised
- AND no schema change MUST occur

### Requirement 8.2: Rollback compatibility

The gateway MUST NOT depend on the three new columns being present in any code path that runs before the migration completes. The migration runs at startup; reads of `gateway_tokens` MUST tolerate the columns being absent only during the brief startup window (or MUST run strictly after migration). After a code revert, the three columns remaining on the table MUST be harmless.

#### Scenario 8.2.1: Code-revert tolerance

- GIVEN the change is fully deployed and rows have non-NULL rate-limit columns
- WHEN the code is reverted (revert merge commit) but the columns remain
- THEN the reverted code MUST function correctly (it never references the new columns; the columns are inert)

#### Scenario 8.2.2: Schema-revert path

- GIVEN the columns are no longer needed and the operator wants to drop them
- WHEN they run `ALTER TABLE gateway_tokens DROP COLUMN rate_limit_per_minute;` etc.
- THEN no operational state MUST be lost (these columns hold pure configuration, not runtime state)

---

## 9. Out of Scope (Explicit Non-Requirements)

The following behaviors are deliberately NOT required by this change. The gateway MUST NOT implement them as part of this change. They MAY be addressed in future changes.

### 9.1 Per-IP rate limiting

The gateway MUST NOT rate-limit by client IP in v1. Unauthenticated flooding of `/health` or `/metrics` is out of scope.

### 9.2 Per-token + per-model granularity

The gateway MUST NOT apply different rate-limit caps depending on the requested model. One bucket per token covers all models.

### 9.3 Persistence of bucket state

Bucket state MUST be process-local and in-memory only. The gateway MUST NOT persist `tokens` or `lastRefillMs` to Turso, Redis, or any other store. As a documented consequence:

- Every gateway restart hands every token a fresh full bucket. This MUST be documented in README.
- The gateway is NOT safe to run multi-instance under this design (effective limit becomes N × cap). This MUST be documented in README.

### 9.4 Queueing / shaping

The gateway MUST NOT queue or delay rate-limited requests. Rejection with `429` is the only response.

### 9.5 Concurrency caps

The gateway MUST NOT enforce a maximum-concurrent-stream cap per token in this change. (`activeStreams` gauge is observed but not enforced.)

### 9.6 LLM-token-based throttling

The rate limiter MUST NOT inspect or charge based on LLM tokens (input/output). `monthly_quota_tokens` already prices LLM tokens; double-charging is forbidden.

### 9.7 New error codes

The gateway MUST NOT introduce new `error_code` values. `RATE_LIMITED` already exists in the enum and MUST be used as-is.

### 9.8 Bucket-reset admin endpoint

The gateway MUST NOT expose an endpoint to manually reset a token's bucket. Buckets refill naturally; for emergencies, the operator MAY restart the gateway (which resets all buckets).

---

## 10. Edge Case Catalog (Cross-Cutting)

### Requirement 10.1: Edge cases

The following edge cases MUST be handled per the linked scenarios:

| Edge case | Scenario(s) |
|---|---|
| Token with `rate_limit_disabled=1` is never throttled | 5.3.1 |
| Public endpoint (`/health`) is not rate-limited | 4.1.5 |
| 404 path does not consume bucket | 4.1.6 |
| Concurrent requests on same token are atomic | 1.3.1 |
| Refill cannot exceed burst capacity (clamp) | 1.1.5 |
| Non-monotonic clock delta is clamped to ≥ 0 | 1.1.6 |
| Stream client-abort does not refund | 1.2.3 |
| Master key under sustained burst is never limited | 5.1.1 |
| Quota-exhausted + rate-empty → `QUOTA_EXCEEDED` (not `RATE_LIMITED`) | 4.1.2 |
| Env defaults applied when DB columns are NULL | 2.1.1 |
| Per-token override beats env default | 2.1.2 |
| Global kill switch disables everything | 5.4.1 |
| Migration idempotent (try/catch ALTER) | 2.2.1, 8.1.2 |
| Dashboard blank input → JSON null → DB NULL → env default | 7.4.1, 2.1.1 |

---

## 11. Notes for Design Phase

These items emerged while specifying and SHOULD be addressed in `design.md`:

- **`X-RateLimit-Reset` semantics:** spec mandates **delta seconds until full bucket** (not Unix timestamp, not seconds-until-next-token). Some clients (notably ones that follow the GitHub API convention) expect a Unix timestamp; this is a contract divergence the design phase MUST acknowledge and document in README.
- **Order of route resolution vs. rate-limit consume:** Scenario 4.1.6 requires that 404 paths NOT consume a bucket. The middleware order in `index.ts` MUST place rate-limit consume *after* known-route matching, OR rate-limit MUST be invoked only inside `/v1/*` handlers. Design phase MUST pick one and justify.
- **Header attachment on 5xx forwarded responses:** Scenario 3.1.3 requires `X-RateLimit-*` headers on 5xx upstream forwards. The streaming path is the trickiest case — design must confirm headers are attached at the SSE response-creation site, not after the body starts flushing.
- **Token-label cardinality in metrics:** Requirement 6.1 labels by `token_label`. If an operator creates many tokens (>50), Prometheus cardinality could grow. Design SHOULD document the recommended ceiling and link to the existing token-creation policy.
