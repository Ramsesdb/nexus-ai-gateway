# Design: rate-limit-per-token

> **Phase:** sdd-design
> **Project:** Nexus AI Gateway (Bun + TypeScript, Turso/LibSQL)
> **Date:** 2026-04-28
> **Predecessor:** `openspec/changes/rate-limit-per-token/spec.md` (22 requirements, 50 scenarios)
> **Mode:** openspec

This document captures HOW the proposal is implemented. Every requirement in `spec.md` must be satisfied by the contracts and call-site flow defined below. Pseudocode and TypeScript signatures are illustrative — final code lands in `sdd-apply`.

---

## Technical Approach

A new pure module **`services/rate-limiter.ts`** owns an in-process `Map<tokenId, BucketState>`. It exposes a single hot-path function `checkAndConsume(tokenId, label, config, now?) -> BucketDecision` whose mutation is fully synchronous (no `await` between bucket read and write). The `index.ts` request handler invokes it after auth and monthly-quota checks, **only for routes that are explicitly classified as rate-limit eligible** (Issue B resolved). The decision shape carries everything needed to (a) build the 429 body, (b) attach `X-RateLimit-*` headers to **every** response on that route — success or error — via a thin response wrapper. Configuration is resolved per-request from the `GatewayToken` row already loaded by auth, with env defaults read **once at module load** (Issue A resolved: `X-RateLimit-Reset` is delta-seconds-until-bucket-full).

---

## 1. Module overview — `services/rate-limiter.ts`

### Public API

```ts
export interface BucketConfig {
  /** Refill rate in requests per minute. Resolved from token override or env default. */
  perMinute: number;
  /** Bucket capacity (max burst). Resolved from token override or env default. */
  burst: number;
  /** True when this token is exempt (per-token flag OR global kill switch). */
  disabled: boolean;
}

export interface BucketDecision {
  /** Whether the request may proceed (false → caller MUST return 429). */
  allowed: boolean;
  /** `Math.floor(currentTokens)` after the (possibly-attempted) consume. */
  remaining: number;
  /** Seconds-until-bucket-is-full. `0` when already full. */
  resetSeconds: number;
  /** Seconds until ≥1 token is available. `0` when allowed=true. */
  retryAfterSeconds: number;
  /** Effective per-minute capacity (= config.perMinute). Echoed in headers. */
  limit: number;
  /** Reason code for metrics/logs: 'allowed' | 'rejected' | 'bypassed'. */
  outcome: 'allowed' | 'rejected' | 'bypassed';
}

/** Hot-path entry. Synchronous. Mutates internal Map. */
export function checkAndConsume(
  tokenId: number,
  label: string,
  config: BucketConfig,
  now?: number, // injectable for tests; defaults to performance.now()
): BucketDecision;

/** Diagnostic accessor. Read-only snapshot. */
export function getBucketState(tokenId: number): Readonly<BucketState> | undefined;

/** Test/debug only — clear all buckets. NOT exposed via HTTP. */
export function clearAllBuckets(): void;

/** Read env defaults. Called once at module load; result memoized. */
export function getEnvDefaults(): { perMinute: number; burst: number; killSwitch: boolean };
```

### Internal state

```ts
interface BucketState {
  tokens: number;              // fractional allowed internally
  lastRefillMs: number;        // monotonic ms (performance.now())
  configSnapshot: BucketConfig; // last config seen (for change detection)
}

const buckets = new Map<number, BucketState>();
```

### Why `Map` not plain object
Predictable iteration, no prototype-pollution risk from numeric keys, O(1) get/set, GC-friendly when entries deleted.

### Memory profile
~80–120 B per entry. 10 000 tokens ≈ 1 MB. Operator-controlled (token count is set by admin), so unbounded growth is bounded in practice.

### Eviction
**None for v1.** Documented as known limitation. Future: a periodic sweep dropping entries with `lastRefillMs > 24 h ago` AND `tokens >= burst` (a "fully-refilled idle" bucket can be dropped without correctness loss because re-creation reproduces the same full state).

---

## 2. Algorithm — lazy refill + atomic consume

### Pseudocode

```
function checkAndConsume(tokenId, label, config, now = performance.now()):
  if config.disabled:
    return { outcome: 'bypassed', allowed: true, remaining: ∞, ... }    // caller skips header attach

  refillPerSec = config.perMinute / 60

  state = buckets.get(tokenId)
  if state is undefined:
    state = { tokens: config.burst, lastRefillMs: now, configSnapshot: config }
    buckets.set(tokenId, state)
  else:
    elapsedMs = Math.max(0, now - state.lastRefillMs)                   // Issue C clamp (Req 1.1.6)
    refillTokens = (elapsedMs / 1000) * refillPerSec
    state.tokens = Math.min(config.burst, state.tokens + refillTokens)  // never exceeds burst (Req 1.1.5)
    state.lastRefillMs = now
    state.configSnapshot = config                                       // pick up live config changes

  if state.tokens >= 1:
    state.tokens -= 1                                                    // ← atomic: no await between this read+write
    return {
      outcome: 'allowed',
      allowed: true,
      remaining: Math.floor(state.tokens),
      resetSeconds: Math.ceil((config.burst - state.tokens) / refillPerSec),
      retryAfterSeconds: 0,
      limit: config.perMinute,
    }

  // Reject path
  needed = 1 - state.tokens
  return {
    outcome: 'rejected',
    allowed: false,
    remaining: 0,
    resetSeconds: Math.ceil((config.burst - state.tokens) / refillPerSec),
    retryAfterSeconds: Math.max(1, Math.ceil(needed / refillPerSec)),    // ≥1 (Req 3.2.3)
    limit: config.perMinute,
  }
```

### Issue A — `X-RateLimit-Reset` semantics (resolved)

| Convention | Format | Why we did NOT pick |
|---|---|---|
| GitHub | Unix timestamp (seconds since epoch) | Clients with skewed clocks compute negative deltas; timezone confusion. |
| OpenAI | `<n>s` text in body, not a header | Ad-hoc, not machine-friendly; no header standard. |
| **Nexus (chosen)** | **Integer delta seconds until bucket fully refilled** | Simple client math (`Date.now() + reset*1000`), no clock-skew hazard. |

**Formula:** `resetSeconds = Math.ceil((burst - currentTokens) / refillPerSec)`. If `currentTokens >= burst`, returns `0`.

#### Worked examples
- `burst=20, perMinute=60` (refill = 1/sec), `currentTokens=14` → `ceil((20-14)/1) = 6`.
- `burst=20, perMinute=60`, `currentTokens=0` → `ceil(20/1) = 20`.
- `burst=20, perMinute=60`, `currentTokens=20` → `0`.
- `burst=10, perMinute=30` (refill = 0.5/sec), `currentTokens=0` → `ceil(10/0.5) = 20`.

### Issue C — Concurrency atomicity (resolved)

The consume function does no `await` between bucket read and write. JavaScript's single-threaded event loop guarantees that any concurrent `checkAndConsume(tokenId=42, …)` calls serialize at function entry; whichever runs first decrements first. Therefore Req 1.3 is satisfied **as long as the function remains synchronous**.

**Invariant for future maintainers:** any introduction of `await`, microtask boundary, or async I/O inside `checkAndConsume` BREAKS atomicity. If we ever swap to Turso-backed state (ADR-1 future work), we MUST replace the pattern with one of: (a) atomic SQL `UPDATE … SET tokens = tokens - 1 WHERE tokens >= 1` returning rowcount; (b) a per-token async lock; (c) Lua script under Redis. A code comment block at the top of `checkAndConsume` will state this invariant explicitly.

#### Test recipe
```ts
clearAllBuckets();
const config = { perMinute: 60, burst: 1, disabled: false };
const results = await Promise.all([
  Promise.resolve(checkAndConsume(42, 'x', config, 1000)),
  Promise.resolve(checkAndConsume(42, 'x', config, 1000)),
  Promise.resolve(checkAndConsume(42, 'x', config, 1000)),
]);
const allowed = results.filter(r => r.allowed).length;
const rejected = results.filter(r => !r.allowed).length;
expect(allowed).toBe(1);
expect(rejected).toBe(2);
```

---

## 3. Integration into request handler (`index.ts`)

### Issue B — Route classification (resolved)

The rate-limit check runs **only on a whitelisted set of authed routes**. Other paths short-circuit to 404/handler without consuming a bucket (Req 4.1.6).

| Path | Auth required | Rate-limited | Headers attached |
|---|---|---|---|
| `/health` | no | no | no |
| `/metrics` | optional (METRICS_TOKEN) | no | no |
| `/dashboard/*` | session | no | no |
| `/admin/*` | master | no | no |
| `/v1/providers/toggle` | master | no | no |
| `/v1/chat/completions` | token or master | **yes (token only)** | yes (token only) |
| `/v1/models` | token or master | **yes (token only)** | yes (token only) |
| `/v1/<unknown>` | token or master | **no** (would 404) | no |
| anything else (404) | n/a | no | no |

**Classifier helper:**

```ts
const RATE_LIMITED_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/models',
]);

function isRateLimitedRoute(pathname: string): boolean {
  return RATE_LIMITED_PATHS.has(pathname);
}
```

We use **exact match against a static set**, not `startsWith('/v1/')`, precisely so unknown `/v1/*` paths bypass the consume (Req 4.1.6). When future routes are added (e.g. `/v1/embeddings`), they MUST be added to the set explicitly.

### Call-site flow (after `authContext` resolution, ~line 1470 of current `index.ts`)

```ts
// authContext already resolved by the existing block at lines 1385–1469.
// Monthly quota is already enforced inline at lines 1432–1450 (returns 429 QUOTA_EXCEEDED).

let rlDecision: BucketDecision | null = null;

if (
  authContext?.type === 'token' &&
  isRateLimitedRoute(url.pathname) &&
  !envDefaults.killSwitch
) {
  const config = configFromToken(token, envDefaults);
  // Note: `token` here is the GatewayToken loaded during auth. We pass it
  // through into a small intermediate (see §4) so we don't re-query the DB.
  rlDecision = checkAndConsume(token.id, token.label, config, performance.now());

  // Observability — call site, not inside the limiter.
  ratelimitTotal.labels(token.label, rlDecision.outcome).inc();

  if (rlDecision.outcome === 'rejected') {
    requestLog.info({
      tag: 'RateLimit',
      token_id: token.id,
      token_label: token.label,
      limit: config.perMinute,
      burst: config.burst,
      retry_after_seconds: rlDecision.retryAfterSeconds,
    }, 'rate limit rejected');

    return withRateLimitHeaders(
      errorResponse(
        429,
        'RATE_LIMITED',
        `Rate limit exceeded for this token. Retry in ${rlDecision.retryAfterSeconds} seconds.`,
        'rate_limit_error',
        corsHeaders,
        {
          extras: {
            retry_after_seconds: rlDecision.retryAfterSeconds,
            limit: rlDecision.limit,
            remaining: 0,
            window: 'minute',
          },
          headers: {
            'Retry-After': String(rlDecision.retryAfterSeconds),
          },
        },
      ),
      rlDecision,
    );
  }
}

// ...existing route dispatch follows. Every Response built downstream
// is passed through withRateLimitHeaders(resp, rlDecision) before return.
```

### Headers strategy — wrap all `/v1/*` responses

We need headers on **every** response (200, 4xx, 5xx; non-streaming AND streaming entry). Two options considered:

| Option | Mechanism | Tradeoff |
|---|---|---|
| A | Clone Response and set headers | 1 clone per response (cheap) |
| B | Thread `decision` into every response builder | Touches many call sites; easy to miss one |

**Decision: Option A.** A single helper `withRateLimitHeaders(resp, decision)` wraps the response **at the outermost return point** for the rate-limited routes. Streaming responses (SSE) are headers-already-set at construction (`new Response(stream, { headers })`); we add the rate-limit headers to the same `headers` object **before** the SSE body starts flushing (Req 3.1.3). For non-streaming, we wrap at `return ...`.

```ts
export function withRateLimitHeaders(resp: Response, d: BucketDecision | null): Response {
  if (!d || d.outcome === 'bypassed') return resp;
  const h = new Headers(resp.headers);
  h.set('X-RateLimit-Limit', String(d.limit));
  h.set('X-RateLimit-Remaining', String(d.remaining));
  h.set('X-RateLimit-Reset', String(d.resetSeconds));
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
```

**Streaming caveat.** When the chat-completions handler builds the SSE `Response`, it MUST do so AFTER `checkAndConsume` returns, and it MUST add the three `X-RateLimit-*` headers to the response's `headers` map at construction time, not via `withRateLimitHeaders` post-hoc (cloning a streaming Response can lose body-stream affinity in some runtimes). The handler will accept `decision` as a parameter and bake the headers in directly. Non-streaming responses go through `withRateLimitHeaders`.

---

## 4. Configuration resolution

### `configFromToken`

```ts
const envDefaults = (() => {
  const perMin = parseInt(process.env.RATE_LIMIT_PER_MINUTE_DEFAULT ?? '', 10);
  const burst  = parseInt(process.env.RATE_LIMIT_BURST_DEFAULT ?? '', 10);
  return {
    perMinute:  Number.isFinite(perMin) && perMin > 0 ? perMin : 60,
    burst:      Number.isFinite(burst)  && burst  > 0 ? burst  : 20,
    killSwitch: process.env.RATE_LIMIT_DISABLED === '1',
  };
})(); // module-load constant; env doesn't change at runtime

export function configFromToken(
  t: GatewayToken,
  defaults = envDefaults,
): BucketConfig {
  return {
    perMinute: t.rate_limit_per_minute ?? defaults.perMinute,
    burst:     t.rate_limit_burst      ?? defaults.burst,
    disabled:  t.rate_limit_disabled === 1 || defaults.killSwitch,
  };
}
```

**Why module-load, not per-request.** Env vars are immutable for a given process. Reading on every request adds zero correctness, only overhead. (Operator changes env → restart → new defaults read once.)

### `AuthContext` does NOT need a new field

The existing `findGatewayTokenBySecret` already loads the full `GatewayToken` row during auth. We thread that row (or a slice of it) directly to the rate-limit call site within the same handler scope — no DB re-read, no `AuthContext` extension. This keeps the auth contract narrow.

(The proposal §Approach suggested extending `AuthContext['token']` with `rateLimit`. We deviate slightly: the simpler design is to keep the loaded `GatewayToken` in a local variable in the handler, since it's already in scope at the auth block. `AuthContext` stays unchanged.)

---

## 5. Schema migration (`services/database.ts`)

### Migration block (added inside `initDatabase`, after the existing `gateway_tokens` CREATE TABLE)

```ts
// Rate-limit override columns. NULL = use env default at runtime.
try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER`); } catch { /* exists */ }
try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER`);      } catch { /* exists */ }
try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
```

Each ALTER is wrapped in its own try/catch (Req 8.1, idempotency). On a fresh DB, the CREATE TABLE statement does NOT include the new columns (we keep the original CREATE TABLE intact); the ALTERs add them every time. This is consistent with the existing pattern at lines 48–53.

### `rowToGatewayToken` extension

```ts
function rowToGatewayToken(r: any): GatewayToken {
  return {
    // ...existing fields...
    rate_limit_per_minute: r.rate_limit_per_minute == null ? null : Number(r.rate_limit_per_minute),
    rate_limit_burst:      r.rate_limit_burst      == null ? null : Number(r.rate_limit_burst),
    rate_limit_disabled:   Number(r.rate_limit_disabled ?? 0) === 1 ? 1 : 0,
  };
}
```

### SELECT statements
`findGatewayTokenBySecret` and `listGatewayTokens` SELECT lists are extended to include the three new columns.

### `createGatewayToken` signature change

```ts
export async function createGatewayToken(
  label: string,
  monthlyQuotaTokens?: number | null,
  notes?: string | null,
  rateLimit?: {
    perMinute?: number | null;
    burst?: number | null;
    disabled?: boolean;
  },
): Promise<{ id: number; secret: string; quotaResetAt: string }>;
```

Validates `perMinute >= 0`, `burst >= 0` if provided; rejects negatives. `disabled` defaults to `false`.

### `updateGatewayToken` signature change

Adds three optional fields to the `changes` parameter, mirroring `monthlyQuotaTokens` semantics:
- `undefined` → leave column as-is (no SET clause emitted)
- `null` (for the two int fields) → SET column = NULL (clear override)
- explicit number → SET column = value
- `disabled: boolean` → SET column = (true ? 1 : 0)

---

## 6. Type changes (`types.ts`)

```ts
export interface GatewayToken {
  // ...existing fields...
  rate_limit_per_minute: number | null;   // NEW — null = use env default
  rate_limit_burst:      number | null;   // NEW — null = use env default
  rate_limit_disabled:   0 | 1;           // NEW — 0/1 as stored in LibSQL
}
```

`AuthContext` is **unchanged** (per §4 rationale).

---

## 7. Admin endpoint changes (`/admin/tokens`)

### `POST /admin/tokens`

Body extended:

```ts
{
  label: string,
  monthlyQuotaTokens?: number | null,
  notes?: string | null,
  ratePerMinute?: number | null,        // NEW
  rateBurst?: number | null,            // NEW
  rateLimitDisabled?: boolean,          // NEW (default false)
}
```

Validation (explicit type guards, no zod — matches repo style):

```ts
function validateOptionalNonNegativeInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
  return v;
}
```

Returns 400 `INVALID_REQUEST` on bad input (matches existing 400 patterns at line 1488).

### `PATCH /admin/tokens/:id`

Same three optional fields. `undefined` = no change; `null` = clear override; number = set. The existing `updateGatewayToken` function is extended (§5) to support this tri-state.

### `GET /admin/tokens` / `GET /admin/tokens/:id`

Response JSON adds three keys:

```json
{
  "id": 7,
  "label": "alice",
  "...": "...",
  "ratePerMinute": 30,        // null if column is NULL
  "rateBurst": 10,            // null if column is NULL
  "rateLimitDisabled": false  // boolean, mapped from 0/1
}
```

---

## 8. Dashboard UI changes (`dashboard.html`)

### Token modal — collapsible "Rate limit" section

The existing token-create modal is dense (label + monthlyQuotaTokens + notes already). Adding 3 more inputs at the same indent crowds it. Solution: a `<details>` element titled "Rate limit (optional)" that is collapsed by default. When expanded:

```
┌── Rate limit (optional) ──┐
│ Requests per minute  [____] (blank = default)
│ Burst capacity        [____] (blank = default)
│ ☐ Disable rate limit for this token
└────────────────────────────┘
```

Frontend rules:
- Empty input → JSON `null` (NOT `0`, NOT empty string).
- Numeric input → JSON `number`.
- Checkbox unchecked → JSON `false`.

### Token list display

Add a "Rate" column showing one of:
- `60/min` (when override set, with burst-20)
- `default` (italic gray, when `ratePerMinute` is null)
- `disabled` (red, when `rateLimitDisabled=true`)

Optional for v1 if dashboard real estate is tight; can be deferred without breaking spec.

---

## 9. Observability hooks

### Metric (`metrics.ts`)

```ts
export const ratelimitTotal = new Counter({
  name: 'gateway_ratelimit_total',
  help: 'Rate limit decisions per token',
  labelNames: ['token_label', 'outcome'] as const,
  registers: [registry],
});
```

Cardinality bound: token_label × outcome (allowed/rejected). Operator-controlled; document recommended ≤50 tokens (Req 6.1 note).

### Increment site
**Outside** `services/rate-limiter.ts` — at the call site in `index.ts`. Rationale: separation of concerns. The limiter is a pure math module; it has no awareness of pino or prom-client. This also makes the limiter trivially unit-testable without mocking metric registries.

### Logging (Req 6.2 / 6.3)
- **Rejected:** `requestLog.info({ tag: 'RateLimit', token_id, token_label, limit, burst, retry_after_seconds }, 'rate limit rejected')`. One line per rejection.
- **Allowed:** silent at `info`. Optional `requestLog.debug({ tag: 'RateLimit', ... }, 'rate limit allowed')` for verbose mode.
- **Bypassed:** silent (master, dashboard session, disabled flag, kill switch all bypass — no log noise on these).

---

## 10. Sequence diagram — request lifecycle

```
client                   index.ts                   rate-limiter.ts   metrics  upstream
  │                         │                              │             │        │
  │ ── POST /v1/chat ──────▶│                              │             │        │
  │                         │ resolveAuth(req)             │             │        │
  │                         │ ─→ authContext = 'token'     │             │        │
  │                         │ checkMonthlyQuota(token)     │             │        │
  │                         │ ─→ ok                        │             │        │
  │                         │ isRateLimitedRoute(path)?    │             │        │
  │                         │ ─→ true                      │             │        │
  │                         │ checkAndConsume(id,cfg) ────▶│             │        │
  │                         │                              │ refill+take │        │
  │                         │◀─── BucketDecision ──────────│             │        │
  │                         │ ratelimitTotal.inc(label,outcome) ────────▶│        │
  │                         │ if !allowed: build 429+headers──┐          │        │
  │                         │   return wrap(errResp, dec)     │          │        │
  │                         │ if allowed: dispatch handler ───┴──────────────────▶│
  │                         │                                                     │ proxy
  │                         │◀──── upstream response ─────────────────────────────│
  │                         │ withRateLimitHeaders(resp, dec)
  │◀─── HTTP 200 + X-RL-* ──│
```

Key invariants:
- The `checkAndConsume` call is **after** auth + quota and **before** route dispatch.
- `withRateLimitHeaders` (or its inline equivalent for streams) wraps **every** response originating from the rate-limited routes.
- Non-rate-limited routes (`/health`, `/admin/*`, `/dashboard/*`, unknown `/v1/*` → 404) NEVER call `checkAndConsume` and NEVER attach the headers.

---

## 11. File Changes

| File | Action | Description |
|------|--------|-------------|
| `services/rate-limiter.ts` | **Create** | Pure module: `BucketConfig`, `BucketDecision`, `BucketState`, `checkAndConsume`, `getBucketState`, `clearAllBuckets`, `getEnvDefaults`. |
| `services/database.ts` | Modify | (a) Three `try/catch ALTER TABLE` after `gateway_tokens` CREATE; (b) `rowToGatewayToken` extended with 3 new fields; (c) SELECT lists in `findGatewayTokenBySecret` and `listGatewayTokens` extended; (d) `createGatewayToken`, `updateGatewayToken` accept the new optional fields. |
| `index.ts` | Modify | (a) Import `checkAndConsume`, `configFromToken`, `withRateLimitHeaders`, `ratelimitTotal`; (b) define `isRateLimitedRoute` + `RATE_LIMITED_PATHS` set near top; (c) insert rate-limit block after line 1470 (post-auth/quota); (d) wrap response returns inside `/v1/chat/completions` and `/v1/models` handlers with headers (or build SSE Response with headers baked in for streams); (e) extend `/admin/tokens` POST/GET/PATCH bodies+responses for the 3 new fields. |
| `types.ts` | Modify | Add `rate_limit_per_minute`, `rate_limit_burst`, `rate_limit_disabled` to `GatewayToken`. |
| `metrics.ts` | Modify | Add `ratelimitTotal` Counter. |
| `errors.ts` | No change | `RATE_LIMITED` already enumerated; `errorResponse.options.headers` and `extras` already supported. |
| `dashboard.html` | Modify | Collapsible "Rate limit" section in token modal (3 inputs); optional "Rate" column in token list. |
| `README.md` | Modify | Document env vars, headers, restart-resets-buckets caveat, multi-instance caveat, GitHub-vs-Nexus reset semantics. |

---

## 12. Architecture Decision Records

### ADR-1: In-memory only for v1
**Choice:** `Map<tokenId, BucketState>` per Bun process; no persistence.
**Alternatives:** Turso-backed atomic `UPDATE`; Redis `INCR`/Lua.
**Rationale:** Single-VPS deployment today. Adding a persistence layer triples blast radius (network round-trip per request, new failure mode, atomicity rewrite). The two known limitations (restart-resets, multi-instance-drift) are tolerable per proposal commitments §3, documented in README. **Migration path**: when horizontal scale is needed, replace `services/rate-limiter.ts` with a Turso/Redis-backed implementation; the public API (`checkAndConsume`) stays identical. Call sites do not change.

### ADR-2: `performance.now()` over `Date.now()`
**Choice:** Monotonic time source for `lastRefillMs`.
**Alternatives:** `Date.now()` (wall clock).
**Rationale:** `Date.now()` can jump backward (NTP sync, daylight-saving, manual clock change), producing negative `elapsedMs` and undefined refill behavior. `performance.now()` is monotonic from process start. The defensive `Math.max(0, elapsedMs)` clamp (Req 1.1.6) is belt-and-suspenders for any future bug that swaps the source.

### ADR-3: Charge-once-at-stream-start, no per-chunk refund
**Choice:** Streaming chat completions consume exactly 1 bucket token at request entry; no per-SSE-chunk decrement, no refund on client abort.
**Alternatives:** (a) Continuous charging (1 token per N chunks); (b) Refund on abort.
**Rationale:** Bucket capacity models **request frequency**, not LLM throughput. LLM-token billing is the existing `monthly_quota_tokens` mechanism; double-charging is forbidden per spec §9.6. Refund-on-abort enables a denial-of-service amplification (rapid open-then-abort pattern would be free), so we explicitly DO NOT refund (Req 1.2.3).

### ADR-4: `X-RateLimit-Reset` = delta seconds, not Unix timestamp
**Choice:** Integer delta seconds until bucket fully refills.
**Alternatives:** GitHub-style Unix timestamp; OpenAI-style body-only `<n>s`.
**Rationale:** Simpler client math (`Date.now() + reset*1000` for an absolute deadline; or just sleep `reset` seconds for full capacity). No clock-skew hazard for clients with bad system clocks. Documented divergence from GitHub in README (clients porting from GH integrations need a one-line adjustment).

### ADR-5: Headers via response wrapper, not body builder threading
**Choice:** `withRateLimitHeaders(resp, decision)` clones non-streaming responses; SSE responses bake headers in at construction.
**Alternatives:** Thread `decision` into every error/success builder signature.
**Rationale:** Threading touches >10 call sites in the existing `/v1/chat/completions` handler (each retry leg, each provider failover, each error path). Wrapper applies once at the outermost return and is correct by default. The single Response clone per request is negligible cost relative to upstream LLM latency.

---

## 13. Test recipes (50 scenarios → unit & integration hints)

Repo has no test harness yet (open question §15). These recipes will inform `sdd-tasks` (will the harness be Bun's built-in `bun:test`? Or vitest?). Each entry is a one-line test sketch.

### §1 Token bucket behavior (10 scenarios)
- **1.1.1** (steady-state allow): pre-fill bucket to 20, call `checkAndConsume` 20 times in a tight loop, expect all `allowed=true`.
- **1.1.2** (burst → 429): same as 1.1.1 then 21st call → `allowed=false, retryAfterSeconds=1`.
- **1.1.3** (refill restores): empty bucket, advance injected `now()` by 1000 ms, `checkAndConsume` → tokens after refill ∈ [1,2], allowed=true.
- **1.1.4** (fractional refill): empty bucket, advance 1500 ms, consume → allowed; internal `state.tokens` after = 0.5 (asserted via `getBucketState`).
- **1.1.5** (cap at burst): bucket at 20, advance 60 000 ms, refill computed → still 20.
- **1.1.6** (negative elapsed clamped): set `state.lastRefillMs = now + 1000` (future), call with `now`, expect no decrement of `state.tokens` (clamp held).
- **1.2.1** (non-streaming charges 1): pre-fill 5, call once, expect remaining=4.
- **1.2.2** (streaming charges 1 at start): integration; mock SSE handler, single consume on entry, no decrement during chunk loop.
- **1.2.3** (abort no refund): pre-fill 1, start stream, abort after 100 ms, immediate retry → `allowed=false`.
- **1.3.1** (atomic race): `Promise.all` of 3 sync calls with bucket=1 → exactly 1 allowed (recipe in §2 above).

### §2 Configuration (5 scenarios)
- **2.1.1** (defaults applied): token row with all NULL, env `60/20`, `configFromToken` → `{60,20,false}`.
- **2.1.2** (override wins): token row `30/10`, → `{30,10,false}`.
- **2.1.3** (per-token disable): `disabled=1`, send 1000 calls, all `outcome=bypassed`.
- **2.2.1** (idempotent ALTER): start gateway twice in succession against the same DB, no error.
- **2.2.2** (fresh DB): empty DB, startup, three columns present.

### §3 API contract (6 scenarios)
- **3.1.1** (200 headers): consume to 14 tokens, integration call → headers `Limit:60, Remaining:14, Reset:6`.
- **3.1.2** (4xx headers): force handler 400 (malformed body), still has 3 headers.
- **3.1.3** (5xx headers): force upstream 502, response 502 has 3 headers.
- **3.2.1** (429 body shape): empty bucket, call → status 429, body fields all present, `Retry-After: 1`.
- **3.2.2** (Retry-After usable): wait `N` seconds after 429, retry → allowed.
- **3.2.3** (delta not date): inspect `Retry-After` → integer, not RFC-1123.

### §4 Integration order (6 scenarios)
- **4.1.1** (auth fail no consume): malformed Authorization → 401 + `getBucketState(?)` unchanged.
- **4.1.2** (quota wins): exhaust monthly quota AND bucket, call → `error.code='QUOTA_EXCEEDED'`.
- **4.1.3** (rate after quota): under quota, empty bucket → `error.code='RATE_LIMITED'`.
- **4.1.4** (admin not limited): master-key call to `/admin/tokens` → no headers, no metric inc.
- **4.1.5** (`/health` not limited): unauth GET `/health` → no headers.
- **4.1.6** (404 no consume): token-authed call to `/v1/does-not-exist` → 404, bucket state unchanged.

### §5 Bypass (4 scenarios)
- **5.1.1** (master sustained): 1000 calls/sec with master key → no 429, no headers.
- **5.2.1** (dashboard session): `/admin/tokens` repeated → no 429, no headers.
- **5.3.1** (per-token disabled): token with `rate_limit_disabled=1`, 1000 calls/sec → no 429, no headers.
- **5.4.1** (kill switch): env `RATE_LIMIT_DISABLED=1`, restart, any call → no headers, no metric inc.

### §6 Observability (4 scenarios)
- **6.1.1** (allowed counter): 1 success → `gateway_ratelimit_total{outcome="allowed"}` += 1.
- **6.1.2** (rejected counter): 1 reject → `gateway_ratelimit_total{outcome="rejected"}` += 1.
- **6.1.3** (bypass no inc): master/disabled/kill → counter unchanged.
- **6.2.1** (reject log): assert pino sink received the 6-field info entry.
- **6.3.1** (allowed silent at info): 100 allowed, 0 RateLimit-tagged info entries.

### §7 Admin endpoints (8 scenarios)
- **7.1.1** (POST with all fields): create with `{ratePerMinute:30,...}` → DB row + response surface.
- **7.1.2** (POST omitted): no rate fields → DB NULLs.
- **7.1.3** (POST explicit nulls): explicit `null` body → DB NULLs.
- **7.2.1** (PATCH overrides): patch `ratePerMinute=10`, others unchanged.
- **7.2.2** (PATCH null clears): patch `ratePerMinute=null`, column NULL.
- **7.2.3** (PATCH toggle disable): patch `rateLimitDisabled=true`, next request bypasses.
- **7.3.1** (GET shape): list returns the 3 fields including `null` for cleared columns.
- **7.4.1** / **7.4.2** (dashboard form): blank input → null, numeric input → number.

### §8 Migration (4 scenarios)
- **8.1.1** (first-run): existing 5-row DB → 3 columns added, rows preserved.
- **8.1.2** (idempotent re-run): restart, no error.
- **8.2.1** (code revert): revert deploy, columns inert.
- **8.2.2** (schema revert): drop columns manually, no operational state lost.

---

## 14. Risks (design-level)

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| **Streaming response header attachment is forgotten** | Medium | Medium (Req 3.1.3 violated) | The handler wrapper for SSE construction MUST take `decision` as a required (non-optional) parameter so TS catches missed call sites at compile time. Code review checklist item. |
| **Future async I/O in `checkAndConsume` breaks atomicity invisibly** | Low (now), Medium (after Redis migration attempt) | High (Req 1.3 silently violated) | (a) JSDoc comment block on the function asserting the invariant; (b) ESLint `no-await-in-function` rule scoped to `services/rate-limiter.ts` (future tightening). |
| **Map grows unbounded over the gateway's lifetime** | Low (operator-controlled token count) | Low (~80 B × N) | Documented in §1 "Eviction". Optional follow-up: idle-bucket sweep. |
| **Headers leak rate-limit metadata to non-eligible callers via response cloning bug** | Low | Low (info disclosure, no auth bypass) | `withRateLimitHeaders` no-ops when `decision === null`; the call site only invokes it when `rlDecision` is set. Test 5.x scenarios assert absence of headers on bypass paths. |

---

## 15. Open Questions

- [ ] **Test harness selection.** The repo currently has no automated tests. `sdd-tasks` should pick `bun:test` (zero extra deps, native to runtime) unless there's a reason to choose vitest. Recommendation: bun:test.
- [ ] **Dashboard "Rate" column rollout.** Optional UI add. Defer if visual real estate is tight; spec doesn't require it.
- [ ] **README diff phrasing for the GitHub-divergent reset semantics.** Wording should be friendly to operators porting GH-API muscle memory. Draft TBD in apply phase.

No blocking unknowns. Design is ready for `sdd-tasks`.

---

## Migration / Rollout

No data migration. The three new columns default to NULL (or 0 for `rate_limit_disabled`), which the runtime resolves to env defaults (60/20). Effect on existing tokens at first deploy: every active token gets the default 60/min, 20-burst limit. Operator can pre-populate per-token overrides via `PATCH /admin/tokens/:id` before deploy if any token is known to need a different cap.

**Soft rollback:** set `RATE_LIMIT_DISABLED=1`, restart. Code revert: revert the merge commit; columns become inert (Req 8.2). Schema revert: manual `ALTER TABLE … DROP COLUMN`, data-destructive but tolerable (config only).
