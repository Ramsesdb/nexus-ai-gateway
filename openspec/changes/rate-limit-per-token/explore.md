# Exploration: rate-limit-per-token

> **Phase:** sdd-explore
> **Project:** Nexus AI Gateway (Bun + TypeScript, OpenAI-compatible)
> **Date:** 2026-04-28
> **Scope:** Per-token request rate limiting (token bucket in memory, optional persistence). Orthogonal to the existing monthly token-budget quota.

---

## 1. Problem Statement & Threat Model

### 1.1 What this defends against

Today the only backpressure inside the gateway is the **provider-level circuit breaker** (`CircuitBreakerState` in `index.ts:97-105`, configured at `index.ts:80-84`). It trips after `failureThreshold = 3` consecutive failures **per upstream provider** and resets after `60s`. This protects the gateway from a sick upstream, but it does **NOT** protect against:

| Scenario | Today | With per-token rate limit |
|---|---|---|
| **Loud client** — a misbehaving SDK on a customer device retries in a tight loop after a 5xx | Drains the OpenRouter monthly free quota in minutes; circuit opens only after upstream starts failing | First N requests/min are allowed, the rest get `429 RATE_LIMITED`. The upstream never sees the flood. |
| **Leaked token** — a token leaks via a public Git push, log file, or browser devtools | Attacker can drain the monthly quota (`monthly_quota_tokens`) at full speed; we only notice when `QUOTA_EXCEEDED` starts firing or when bills arrive | Attacker is capped at `rate_limit_per_minute`, giving the operator (Ramses) time to notice anomalous traffic in metrics/dashboard and revoke the token. |
| **Runaway script** — a user's local cron forgets to back off and hammers `/v1/chat/completions` | Same as loud client; can also spike CPU on the single VPS Bun process | Cap holds the throughput, circuit breaker stays closed for healthy providers, monthly quota lasts the full month. |
| **Intentional abuse** — a token holder tries to use the gateway as a free public proxy by sharing the secret with friends | No per-token rate cap — only the shared monthly quota | Visible early via `gateway_ratelimit_total` spike on that token's label; admin can revoke. |
| **Cost firewall while debugging** — operator hands a teammate a dev token and wants a hard ceiling | Only knob is monthly cap; nothing prevents burning the whole cap in one afternoon | A 60 req/min cap means worst-case ≈ 86 400 req/day, a useful natural ceiling even if monthly quota is generous. |

### 1.2 What this does NOT defend against (out of scope, document explicitly)

- **Distributed leaks across many tokens.** If many tokens are abused simultaneously, each individual rate limit holds, but the sum can still exhaust upstream monthly quotas. Mitigation lives at the provider account level and is outside this change.
- **Upstream pricing surprises.** Rate-limit counts requests, not USD/tokens. A token user on a 30 req/min cap can still rack up bills by sending huge contexts. The existing `monthly_quota_tokens` is the correct guardrail there.
- **Application-layer DDoS.** A single TCP-level flood from a botnet without valid bearer auth fails at `AUTH_INVALID` (`index.ts:1417`) before the rate limiter is consulted. Pre-auth flooding belongs to a future "per-IP rate limit" change (mentioned as an OPEN question in §4).
- **Multi-instance fairness.** The recommended in-memory bucket is per-process; if/when the gateway is scaled horizontally, a token could get `N × cap` when load-balanced across N instances. Acceptable for the current single-VPS deployment but flagged as a known limitation.
- **Long-running stream abuse.** A streaming chat completion can hold a connection open for minutes. The rate limit is a *request-rate* limit, not a *concurrency* limit. Concurrency caps are a separate concern (potential follow-up change).

### 1.3 Why now

- Two recent commits (`fe74f79` structured logging+metrics, `80c420b` error_code enum with `RATE_LIMITED` reserved) put the foundation in place — observability and the response shape are already there.
- The gateway has crossed from "single user" to "tokens handed out to friends/teammates" (per the comment at `services/database.ts:77-79`). The blast radius of one abusive token is no longer hypothetical.

---

## 2. Code Reading

### 2.1 Auth + monthly quota check (insertion point for rate-limit)

`index.ts:1381-1470` is the auth block. The relevant flow for an authenticated `/v1/*` request:

| Lines | Behavior |
|---|---|
| `1386-1390` | `requiresAuth` = true when master key is set AND path is not `/health`, `/metrics`, or `/dashboard/*`. |
| `1395-1397` | `adminOnlyPath` = `/admin/*` or `/v1/providers/toggle`. These reject per-user tokens. |
| `1408-1414` | Dashboard session cookie counts as `master` for `/admin/*` only. |
| `1426-1427` | Bearer matches `CONFIG.masterKey` → `authContext = { type: 'master' }`. |
| `1428-1458` | Bearer is checked against `gateway_tokens.secret` via `findGatewayTokenBySecret`. If found and active, the **monthly quota check** fires inline (`1432-1450`): `used_tokens_current_month >= monthly_quota_tokens` → `429 QUOTA_EXCEEDED`. Otherwise `authContext = { type: 'token', tokenId, label, ... }`. |
| `1461-1469` | Final fall-through: any unresolved bearer → `401 AUTH_INVALID`. |

**Insertion point:** Immediately after `authContext` is finalized (after line `1469`) and before the route-specific handlers begin (`/admin/tokens` POST starts at `1477`, `/v1/chat/completions` at `1703`). At that point we know:
- `authContext.type` (`'master' | 'token'`)
- For tokens: `tokenId`, `label`, current monthly usage
- We have NOT yet parsed the request body, NOT yet routed, NOT yet called any upstream

This is the cheapest possible point to reject — no JSON parse, no router work, no upstream call.

**Concrete shape of the new check:** a thin helper called once after line `1469`, scoped to `authContext.type === 'token'` and `url.pathname.startsWith('/v1/')` (so `/admin/*` and the master key continue to bypass — see §4 for the master-bypass decision). On reject, return `errorResponse(429, 'RATE_LIMITED', ..., { headers: { 'Retry-After': ..., 'X-RateLimit-...': ... } })`.

**Order vs monthly quota check:** the monthly quota check (`1432-1450`) is *inside* the token-resolution branch and fires **first**. Rate-limit fires **after** quota. Rationale: if a client is over their monthly cap they should always learn that, even if they're also being rate-limited. It also keeps the monthly-cap flow undisturbed (a known-good code path with passing manual tests). See §6 for the full ordering discussion.

### 2.2 `gateway_tokens` schema

`services/database.ts:80-95`:

```sql
CREATE TABLE IF NOT EXISTS gateway_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  monthly_quota_tokens INTEGER,
  used_tokens_current_month INTEGER NOT NULL DEFAULT 0,
  quota_reset_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  notes TEXT
)
```

Plus indices on `secret` (`:94`) and `active` (`:95`).

Existing columns relevant here:
- `monthly_quota_tokens` — **billing cap**, in LLM tokens. Orthogonal to rate-limit.
- `used_tokens_current_month` — counter for the billing cap.
- `active` — soft-revoke flag we should respect (an inactive token should never reach the rate limiter; auth rejects it first at `1431`).
- `label` — used as the metric label (low-cardinality if operators keep labels short).

**Existing migration pattern** in this file: optional column adds use `try { db.execute(`ALTER TABLE ... ADD COLUMN ...`) } catch { /* exists */ }` (see `services/database.ts:48-53`). The same pattern works for the new rate-limit columns.

**Helper functions to extend** if we put the new fields on `gateway_tokens`:
- `rowToGatewayToken` (`:261-274`) — add the 2-3 new fields.
- `findGatewayTokenBySecret` (`:280-293`) — extend the `SELECT` column list.
- `listGatewayTokens` (`:395-410`) — same.
- `createGatewayToken` (`:360-381`) — accept optional rate-limit fields.
- `updateGatewayToken` (`:433-462`) — admit rate-limit field updates.
- `GatewayToken` type in `types.ts:~190-216` — extend.

### 2.3 Existing metrics shape

`metrics.ts:15-66` defines counters/histograms/gauges via `prom-client`. Existing label conventions:

| Metric | Labels | Notes |
|---|---|---|
| `gateway_requests_total` | `method, path, status, error_code` | High-cardinality risk on `path` is already accepted. `error_code` already takes `'none'` for success and the `ErrorCode` enum otherwise — so 429s today land here as `error_code='QUOTA_EXCEEDED'`. We will land 429s for the new feature as `error_code='RATE_LIMITED'`. |
| `gateway_upstream_requests_total` | `provider, model, status, outcome` | `outcome ∈ {success, retried, failed}` per `:33`. |

**New metrics to add (preview, not final):**

```ts
export const ratelimitDecisionsTotal = new Counter({
  name: 'gateway_ratelimit_total',
  help: 'Rate-limit decisions per token',
  // outcome: allowed | throttled
  labelNames: ['token_label', 'outcome'] as const,
  registers: [registry],
});
```

If queueing is introduced (rejected by recommendation, see §4), a second histogram `gateway_ratelimit_queue_wait_ms` would be appropriate. **Strong rec: no queue, no histogram.** A queue blurs error semantics (clients get either slow or fast 200s, never a 429) and adds memory pressure; a clean 429 with `Retry-After` is the OpenAI-compatible behavior clients already understand.

**Cardinality concern.** `token_label` is operator-controlled and tokens are handed to friends/teammates (low N — likely <50). Acceptable. If labels ever get user-generated or PII, swap to `token_id_str`. Do NOT use the bare token id as a label only because Prometheus already accepts it; use `label` for human readability of dashboards.

### 2.4 `RATE_LIMITED` reservation and HTTP status

`errors.ts:23` confirms `RATE_LIMITED` is in the `ERROR_CODES` const tuple. `errorResponse` accepts an arbitrary HTTP status; we will use **`429 Too Many Requests`** (RFC 6585).

`errorResponse` already supports merging extra headers via `options.headers` (`errors.ts:62-64`). This is the hook for `Retry-After` and the four `X-RateLimit-*` headers. No changes to `errors.ts` required.

### 2.5 Logger pattern

`logger.ts:22-43` is the root pino logger; `requestLogger(traceId, extra)` returns a `child` logger (`:47-49`). Existing log lines pattern:

```ts
log.info({ tag: 'ModelConfig', model, provider, ... }, 'human readable')   // index.ts:1848
log.warn({ tag: 'GatewayReturningError', status, error_code, duration_ms }, '...')   // index.ts:1773
```

Convention: every log line carries a `tag` field for grep/Loki filtering. **For rate limiter, use `tag: 'RateLimit'`.** Two log lines we'll need:

```ts
log.warn({ tag: 'RateLimit', token_id, token_label, limit, burst, retry_after_ms }, 'rate-limited')
log.debug({ tag: 'RateLimit', token_id, remaining, capacity }, 'allowed')   // optional, debug-only
```

The `debug` line is optional; under `LOG_LEVEL=info` it won't fire. **Strong rec: emit it only at `debug` level**, otherwise we 5x the volume of operational logs for normal traffic.

### 2.6 Admin endpoints (`/admin/tokens`)

| Lines | Handler | Behavior |
|---|---|---|
| `1477-1511` | `POST /admin/tokens` | Creates a token. Currently accepts `{ label, monthlyQuotaTokens, notes }`. **Will need** `ratePerMinute`, `rateBurst` (or `rateLimitDisabled`) optional inputs. |
| `1513-1531` | `GET /admin/tokens` | Lists. Will need to expose the new columns in the response shape. |
| `1533-1578` | `PATCH /admin/tokens/:id` | Updates `active`/`monthlyQuotaTokens`/`notes`. **Will need** to accept the new fields. |
| `1540-1553` | `DELETE /admin/tokens/:id` | Soft-revoke. No change. |
| `1580-1598` | `POST /admin/tokens/:id/reset-usage` | Resets monthly counter. Possibly add a sibling `reset-rate-limit` to drop bucket state, but **not strictly necessary** — bucket refills naturally and waiting is fine. |

The admin surface is master-only auth (`adminOnlyPath` at `index.ts:1395-1397` blocks token-bearer access). Dashboard session counts as master. So **admin endpoints already bypass per-token rate limit by virtue of the rate limiter only running for `authContext.type === 'token'`**.

---

## 3. Algorithm Choice

| Algorithm | Pros | Cons | Fit for AI gateway |
|---|---|---|---|
| **Token bucket** (capacity = burst, refill rate = N/sec) | Native bursting (a quiet client can save up budget for a flurry); steady-state rate is exact; tiny per-token state (2 floats: `tokens`, `last_refill_ms`) | Slightly trickier to explain than fixed-window; need monotonic time | **Best.** Chat completions are inherently bursty (user types a few in a row, then idles). Burst capacity matches the human pattern. |
| **Fixed window** (count requests in N-second buckets) | Trivial to implement; fits a single integer counter per token per window | **Boundary thundering herd**: a client with 60 req/min can fire 60 at 12:00:59 and 60 at 12:01:00 = 120 in 2 seconds, and we can't tell. | Bad. Bursting at boundary defeats the purpose for an AI gateway since 120 chat completions in 2 seconds is exactly the abuse case. |
| **Sliding window log** (timestamp queue per token) | Pixel-perfect accuracy: exactly N requests in any 60s wall-clock window | **Memory grows with the rate**: at 60 rpm × 50 active tokens × 60s of history = 3000 timestamps held forever | Overkill. Memory cost > value; AI rate limiting doesn't need second-by-second exactness. |
| **Sliding window counter** (hybrid: weighted average of current + previous fixed window) | Smoother than fixed window without the log's memory cost; one counter per token per window (small) | Approximates rather than enforces; harder to tune; `Retry-After` math is fiddly | Decent middle ground but has no advantage over token bucket here. |

### 3.1 Recommendation: **token bucket**

- Per-token state is just `{ tokens: number, lastRefillMs: number }` — two numbers in a `Map<tokenId, BucketState>`. With 100 tokens, that is a few KB total. Memory is a non-issue.
- Refill is purely lazy (compute on read) — no background timers, no setInterval, no per-token wakeups. A bucket that's never queried costs zero CPU.
- Burst capacity gives clients a natural "small flurry of related requests" budget without an operator-friendly false-positive on, e.g., a user who edits a prompt 3 times in 5 seconds.
- `Retry-After` is straightforward: `(1 - currentTokens) / refillPerSecond` rounded up to seconds.
- Industry alignment: Stripe, GitHub, AWS API Gateway all use token-bucket-equivalent semantics in their public docs. Operators reading our 429 headers will recognize the shape.

### 3.2 Refill formula (sketch, not final)

```ts
function refill(state: BucketState, now: number, ratePerSec: number, capacity: number) {
  const elapsedSec = (now - state.lastRefillMs) / 1000;
  state.tokens = Math.min(capacity, state.tokens + elapsedSec * ratePerSec);
  state.lastRefillMs = now;
}

function consume(state, now, ratePerSec, capacity, cost = 1): { allowed: boolean; retryAfterMs: number; remaining: number } {
  refill(state, now, ratePerSec, capacity);
  if (state.tokens >= cost) {
    state.tokens -= cost;
    return { allowed: true, retryAfterMs: 0, remaining: state.tokens };
  }
  const deficit = cost - state.tokens;
  return { allowed: false, retryAfterMs: Math.ceil((deficit / ratePerSec) * 1000), remaining: state.tokens };
}
```

`now` should come from `Bun.nanoseconds() / 1e6` or `performance.now()` (monotonic), NOT `Date.now()` (wall-clock). NTP slews on `Date.now()` could cause negative `elapsedSec` and undefined behavior. See §7 risks.

---

## 4. Scope Decisions (OPEN questions for sdd-propose)

Each item below is flagged **OPEN** for the proposal phase. Recommendations are given but not final.

### 4.1 Granularity — per-token only? per-token+model? per-IP fallback?

| Option | Pros | Cons |
|---|---|---|
| **Per-token only** (recommended for v1) | Simple state shape (`Map<tokenId, BucketState>`); easy to explain; matches the threat model (abusive tokens) | A token holder who alternates models can spread load; not a problem for our threat model |
| Per-token + per-model | Aligns with upstream provider rate limits (OpenRouter has per-model caps) | Doubles state cardinality; rare in industry; YAGNI for v1 |
| Per-IP fallback for unauth paths | Defends `/v1/models` and `/health` from public flooding | These endpoints are cheap and already cached; not the threat we're solving. Adds significant complexity (IP extraction, X-Forwarded-For trust, IPv6 normalization) |

**Recommendation: per-token only for v1.** OPEN: revisit per-token+model in a follow-up if we observe specific upstream-model exhaustion patterns. Per-IP fallback is a **separate change**, not v1.

### 4.2 Persistence

| Option | Pros | Cons |
|---|---|---|
| **In-memory only** (recommended) | Zero DB load on hot path; refill is pure CPU; simplest possible code | Bucket state lost on restart → token gets a free full-bucket on each deploy. Acceptable: single-VPS, deploys are infrequent and operator-driven. |
| Turso-backed | Survives restarts; future-proof for multi-instance | Adds DB write per allowed request OR per refill; latency on every `/v1/*` call; inconsistent with the "lazy refill" elegance of the bucket |
| Hybrid (in-mem hot + Turso lazy-write on bucket-empty events) | Best of both | Complex; the consistency model is hand-wavy unless designed carefully |

**Recommendation: in-memory only for v1.** Document the "deploy hands a free bucket" caveat. Re-evaluate when (if) we go horizontal. Turso is already the source of truth for the **configuration** (the limits per token); only the **state** (current bucket level) is in memory.

### 4.3 What counts as a "request"?

| Option | Pros | Cons |
|---|---|---|
| **Count POSTs to `/v1/chat/completions` (1 = 1)** (recommended) | Aligns with upstream-provider rate limits (which are also requests/min); easy to explain; cheap to enforce (just before routing) | A token holder sending huge contexts costs more LLM tokens than a small one — but `monthly_quota_tokens` already covers that |
| Charge LLM-tokens-out (variable cost per request) | More fair to "small request" users | Tokens-out are unknown until the response completes (especially for streams); we'd have to charge after the fact, which defeats the front-door 429 |
| Charge LLM-tokens-in (estimated) | Some fairness for large contexts | Requires tokenization in the gateway hot path; expensive |

**Strong recommendation: 1 request = 1 bucket consumption.** The monthly quota already prices LLM tokens. Don't double-charge for context size — it conflates two concerns.

### 4.4 Streaming behavior

| Option | Pros | Cons |
|---|---|---|
| **Charge once at request start** (recommended) | Predictable; simple; matches what every public LLM API does | A 5-minute-long stream uses 1 bucket slot — could feel "unfair" for short prompts vs long, but really isn't |
| Charge continuously (e.g., 1 token per N seconds of stream) | "Fair" by stream duration | Code complexity in the SSE loop; would need to abort streams that run out of bucket (bad UX); no industry precedent |
| Charge per chunk emitted | Granular | Same complexity; meaningless to clients |

**Strong recommendation: charge at request start (after auth, before routing).** Long streams already consume an SSE connection (tracked by `activeStreams` gauge in `metrics.ts:53-57`); concurrency caps are a separate concern.

### 4.5 Headers exposed on 200/429

Industry conventions (no perfect standard):

| Header | Meaning | Sources |
|---|---|---|
| `X-RateLimit-Limit` | Total capacity for this token's window (the burst, or rate per minute, depending on provider) | GitHub, Stripe, Anthropic |
| `X-RateLimit-Remaining` | Remaining capacity (integer) | GitHub, Stripe, Anthropic |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the bucket is fully refilled OR the next slot frees up | GitHub uses unix-seconds; Twitter/X uses seconds-until |
| `Retry-After` (429 only) | Seconds (or HTTP date) before the next retry will succeed | RFC 9110 §10.2.3 |

**Recommendation: expose all four.**
- On `200`: include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Operators love this — they can debug from a `curl -i`.
- On `429 RATE_LIMITED`: include those three PLUS `Retry-After` in seconds (integer).
- For `X-RateLimit-Reset`, use **seconds-until-full-refill** (relative integer), NOT a unix timestamp. Easier for clients on phones/laptops with skewed clocks. Document this choice clearly because GitHub uses absolute. **OPEN** for proposer.

### 4.6 Default config

What should the defaults be when a token has `rate_limit_per_minute = NULL`?

- A reasonable AI-chat default for hobbyists/teammates: **60 req/min, burst 20**. That allows a normal user to fire 20 quick requests, then refills 1 every second.
- Operator can override per-token in `/admin/tokens` PATCH.
- **OPEN** for proposer: should the default be configurable via env vars (`NEXUS_DEFAULT_RATE_PER_MIN`, `NEXUS_DEFAULT_RATE_BURST`)? **Strong rec: yes**, for ops flexibility without a code change.

### 4.7 Master key bypass

**Strong recommendation: master key bypasses rate limit.** Rationale: master key is the operator's own credential, used for admin scripts, dashboard backend calls, and emergency manual operations. Rate-limiting the operator out of their own gateway is a footgun. If the master key leaks, the answer is rotation, not throttling.

This falls out naturally from the implementation: rate limiter only runs when `authContext.type === 'token'`.

### 4.8 Dashboard session bypass

**Recommendation: yes, bypass.** A logged-in operator clicking around the dashboard is the same person as the master key holder. The dashboard session resolves to `authContext.type === 'master'` for `/admin/*` (`index.ts:1408-1414`), so this is also automatic.

### 4.9 Admin endpoints rate-limited?

**No.** `/admin/*` paths are master-key-only (or dashboard-session-only) and are blocked from per-user tokens at `index.ts:1395-1397`. Per the bypass rules above, master/dashboard always bypasses. So admin endpoints are de-facto unlimited. Confirmed correct.

### 4.10 What about `/v1/models`?

`/v1/models` (`index.ts:1678+`) is auth-required (it's not in the auth bypass list). A per-user token holder calling `/v1/models` in a tight loop is the same threat class as `/v1/chat/completions`. **Recommendation: yes, rate-limit `/v1/models` too**, simplest to apply the limiter to *all* `/v1/*` paths uniformly. Cost is negligible — `/v1/models` is a static array.

OPEN: do we want a separate, lighter rate-limit policy for `/v1/models` (e.g., 10x the chat-completions cap)? Probably overkill for v1.

---

## 5. Schema Changes Preview

### 5.1 Option A: extend `gateway_tokens` (recommended)

```sql
-- Migrations (idempotent, matching the existing pattern at services/database.ts:48-53):
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER;  -- NULL = use NEXUS_DEFAULT_RATE_PER_MIN
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER;       -- NULL = use NEXUS_DEFAULT_RATE_BURST
-- Optional explicit kill switch for "this token bypasses rate limit" (e.g. internal monitor token).
ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0;
```

**Pros:**
- One row read per auth (we already do this in `findGatewayTokenBySecret`).
- Migrations are trivial — pattern already used in this codebase.
- All token config travels together — easier admin UX.

**Cons:**
- Adds three columns to a table that's already at 10 columns. Still tiny.

### 5.2 Option B: separate `rate_limits` table keyed by `token_id`

```sql
CREATE TABLE rate_limits (
  token_id INTEGER PRIMARY KEY REFERENCES gateway_tokens(id) ON DELETE CASCADE,
  rate_per_minute INTEGER,
  burst INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
```

**Pros:**
- Cleaner separation of concerns.
- Easier to evolve (add e.g. `rate_per_hour`, `concurrency_cap`) without touching `gateway_tokens`.

**Cons:**
- Extra JOIN on every auth — small but real.
- Two-row tx for create/update — `createGatewayToken` becomes more code.
- Premature for v1. We have one operator, no DBA review process, no schema-migration tooling beyond the inline `ALTER TABLE try/catch` pattern.

**Recommendation: Option A.** Revisit Option B if/when we add a third independent policy dimension (e.g., concurrency caps).

### 5.3 Type changes

`types.ts:200-216` currently:

```ts
export interface GatewayToken {
  id: number;
  label: string;
  secret: string;
  active: 0 | 1;
  monthly_quota_tokens: number | null;
  used_tokens_current_month: number;
  quota_reset_at: string | null;
  created_at: string;
  last_used_at: string | null;
  notes: string | null;
}

export type AuthContext = ...
```

Will need to add:

```ts
rate_limit_per_minute: number | null;
rate_limit_burst: number | null;
rate_limit_disabled: 0 | 1;
```

`AuthContext` for `type: 'token'` may also need to carry the resolved limits forward so the rate-limiter check doesn't re-read the row:

```ts
| { type: 'token'; tokenId: number; label: string; monthlyQuota: number | null; used: number;
    rateLimit: { perMinute: number; burst: number; disabled: boolean } }
```

…where `rateLimit` is **resolved at auth time** (DB row → defaults applied), so the rate limiter just consumes from the in-memory bucket using these resolved numbers.

---

## 6. Interaction With Existing Systems

### 6.1 Rate-limit vs monthly quota — order

| Order | Pros | Cons |
|---|---|---|
| **Quota first, rate-limit second** (recommended, matches current code order) | A client over their monthly quota always learns about the quota issue specifically. Doesn't disrupt the existing tested code path. | A token that's over both will see `QUOTA_EXCEEDED` (which might be harder to diagnose since they also have a rate problem). Acceptable. |
| Rate-limit first, quota second | A client being throttled gets the rate signal first | The quota check is `O(1)` already (in-memory after DB read) and is more likely to be the "real" stop condition for a long-running token. Reordering for theoretical purity isn't worth disturbing a tested path. |

**Recommendation: quota first, then rate-limit.** Both are 429 with distinct `error_code`s, so clients can branch — that's exactly what the new error_code enum was built for.

### 6.2 Rate-limit vs routing

**Rate-limit fires BEFORE routing.** No point burning routing CPU + an upstream call if we'll reject. Concrete insertion: after `authContext` is finalized at `index.ts:1469`, before any path-specific handler runs.

### 6.3 Circuit-broken upstream

Scenario: all providers are circuit-open → request would 503 with `NO_PROVIDER_AVAILABLE`/`CIRCUIT_OPEN`. Did the request consume a bucket slot?

Two possibilities:
- **Charge at front door (before circuit knowledge)** — recommended. Symmetric with how rate limit works in industry. Even if upstream is failing, the *gateway* did work to authenticate, validate, and route.
- **Refund on no-provider-available** — adds complexity, edge cases (what about partial failures? retries?). Inconsistent: a request that 503s due to circuit breaker would not consume bucket, but a request that 503s due to upstream timeout would. Operators won't predict this behavior.

**Recommendation: charge at front door, no refunds.** Simpler, predictable. The 429-rate-limit and 503-circuit-open paths stay clean and independent.

### 6.4 Per-request streaming bucket

Already covered in §4.4: charge once on request entry. SSE chunks do not refill or consume.

### 6.5 Metrics emission point

The rate-limit decision (allowed/throttled) should emit `gateway_ratelimit_total` exactly once per request, immediately after the consume call. The existing `gateway_requests_total{status="429", error_code="RATE_LIMITED"}` will also tick — that's fine, the two metrics serve different dashboards (rate-limiter health vs request totals).

---

## 7. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| **Memory growth from many tokens.** A `Map<tokenId, BucketState>` grows without bound. | Low (operator controls token count) | Low (state is ~64 bytes/token; 1000 tokens = 64 KB) | Document. Optional: LRU-evict buckets that are full and idle for >1h (tiny saving, low priority). |
| **Restart loses state.** On deploy, every token gets a free full bucket. | High (deploys happen) | Low (one burst per deploy) | Document explicitly. Acceptable. |
| **Multi-instance deploy in the future.** Each Bun process has independent buckets → effective limit = `N × cap`. | Low today (single VPS) | Medium if we scale | Document as known limitation. Solution path: switch to Turso-backed atomic counter or Redis if ever needed. |
| **Clock skew / monotonic time.** Using `Date.now()` for refill makes the bucket vulnerable to wall-clock jumps (NTP slew, leap second handling). A backwards jump → negative elapsed → undefined behavior. | Low | Medium (intermittent over-allow on systems with slewed clocks) | Use `performance.now()` or `Bun.nanoseconds() / 1e6` (monotonic). Confirm Bun runtime guarantee. Add a clamp `Math.max(0, elapsed)`. |
| **Distinguishing 429-rate-limit from 429-quota-exceeded in client retry logic.** A naive client sees "429" and retries forever. | Medium | Medium (client devs not always reading body) | Already mitigated by `error_code` field (`RATE_LIMITED` vs `QUOTA_EXCEEDED`). `Retry-After` differs: quota = next month (huge), rate = seconds. A thoughtful retry library will respect `Retry-After`. Document in README/changelog. |
| **Label cardinality.** Operator could create tokens with PII labels ("Juan's Wallex test token"). | Low | Low (Prom can handle 50 labels easily) | Already a private gateway with operator-controlled labels. Future: warn at admin endpoint when label looks like an email/phone. |
| **Header bloat on 200.** Adding 3 extra headers to every successful chat completion. | High (every request) | Negligible (~80 bytes/response) | Document in proposal. Operators can opt out via env if needed. |
| **First-request burst draining at restart.** N clients all retry at once when the VPS restarts and the rate limiter is fresh → upstream can still see N concurrent calls. | Medium | Low (this is exactly the burst behavior the bucket allows by design) | Already mitigated by upstream circuit breaker as backstop. |

---

## 8. Referenced Standards

- **RFC 6585 §4** — defines `429 Too Many Requests`, allows `Retry-After` header. <https://www.rfc-editor.org/rfc/rfc6585#section-4>
- **RFC 9110 §10.2.3** — `Retry-After` header semantics: either `delta-seconds` (integer) or `HTTP-date`. We will use delta-seconds.
- **De-facto rate-limit headers (no IETF spec):**
  - GitHub: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix timestamp).
  - Stripe: same trio, but `X-RateLimit-Reset` is also seconds-until.
  - Anthropic: `anthropic-ratelimit-requests-limit/-remaining/-reset` (timestamp).
  - There is an in-progress `RateLimit-*` IETF draft (draft-ietf-httpapi-ratelimit-headers) but it's not stable. **Recommendation: stick with the `X-RateLimit-*` legacy convention** — every popular HTTP client lib already understands it.

---

## Summary

**Recommendation:** in-memory **token bucket** (per-token, request-counting, charged at request start, master/dashboard bypass), backed by 3 new optional columns on `gateway_tokens`. Inserted at `index.ts:~1470` after auth resolves and before any handler runs. Emits `gateway_ratelimit_total{token_label, outcome}` and four standard headers. Returns `429 RATE_LIMITED` with `Retry-After`.

**Top 3 OPEN scope decisions for sdd-propose:**
1. Default rate config — one shared default (60/20) vs env-overridable. (Strong rec: env-overridable.)
2. `X-RateLimit-Reset` semantics — seconds-until vs unix-timestamp. (Strong rec: seconds-until.)
3. Persistence model — pure in-memory now vs design hybrid Turso-backed for future horizontal scale. (Strong rec: pure in-memory; document caveat.)

**Biggest risk:** restart-resets-buckets is a real and visible behavior the operator must be told about. Everything else is documentation work.
