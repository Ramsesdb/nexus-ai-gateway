# Tasks: rate-limit-per-token

> **Phase:** sdd-tasks
> **Predecessors:** `proposal.md`, `spec.md` (22 reqs / 50 scenarios), `design.md` (5 ADRs)
> **Mode:** openspec
> Hierarchical checklist; each leaf = one apply batch (~30-90 min). Annotations cite spec §X.Y.Z or design §N.

---

## Phase 1 — Infrastructure

- [x] **1.1** Schema migration in `services/database.ts`
  - [x] 1.1.1 Add 3 sequential `try { ALTER TABLE gateway_tokens ADD COLUMN ... } catch {}` blocks for `rate_limit_per_minute INTEGER`, `rate_limit_burst INTEGER`, `rate_limit_disabled INTEGER NOT NULL DEFAULT 0`, placed after the existing `gateway_tokens` CREATE TABLE → spec §2.2, §8.1; design §5.
  - [x] 1.1.2 Extend `rowToGatewayToken` to map the 3 new columns: `rate_limit_per_minute` and `rate_limit_burst` as `number | null` (preserve NULL), `rate_limit_disabled` as `0 | 1` → spec §2.2; design §5.
  - [x] 1.1.3 Extend SELECT lists in `findGatewayTokenBySecret` and `listGatewayTokens` to include the 3 new columns → design §5.

- [x] **1.2** Type extensions in `types.ts`
  - [x] 1.2.1 Add `rate_limit_per_minute: number | null`, `rate_limit_burst: number | null`, `rate_limit_disabled: 0 | 1` to `GatewayToken` interface. Leave `AuthContext` unchanged → design §4, §6. *Blocks 1.1.2 compile.*

- [x] **1.3** Metric registration in `metrics.ts`
  - [x] 1.3.1 Register `gateway_ratelimit_total` Counter with labels `['token_label', 'outcome']`; export as `ratelimitTotal` → spec §6.1; design §9.

- [x] **1.4** Env var defaults
  - [x] 1.4.1 Define module-load `envDefaults` constant inside `services/rate-limiter.ts` (created in 2.1): parse `RATE_LIMIT_PER_MINUTE_DEFAULT` (fallback 60), `RATE_LIMIT_BURST_DEFAULT` (fallback 20), `RATE_LIMIT_DISABLED === '1'` → spec §2.1, §5.4; design §4 ADR (module-load, not per-request). *Folded into 2.1.1 if convenient.*

---

## Phase 2 — Implementation

- [x] **2.1** Create `services/rate-limiter.ts`
  - [x] 2.1.1 Define `BucketState` (internal), `BucketConfig`, `BucketDecision` types per design §1; instantiate `const buckets = new Map<number, BucketState>()` → design §1.
  - [x] 2.1.2 Implement `checkAndConsume(tokenId, label, config, now?)` synchronous: lazy refill, `Math.max(0, elapsedMs)` clamp (spec §1.1.6), `Math.min(burst, tokens + refill)` clamp (spec §1.1.5), allow path decrements 1 token, reject path computes `retryAfterSeconds = Math.max(1, ceil(needed/refillPerSec))` (spec §3.2.3) → spec §1.1, §1.2, §1.3; design §2.
  - [x] 2.1.3 `now` parameter optional with `performance.now()` default (monotonic per ADR-2) → design §12 ADR-2.
  - [x] 2.1.4 Disabled config short-circuits to `{ outcome: 'bypassed', allowed: true }` (no decrement, no headers downstream) → spec §5.3, §5.4.
  - [x] 2.1.5 Export diagnostics: `getBucketState(tokenId)` (read-only snapshot) and `clearAllBuckets()` (test/debug only, NOT exposed via HTTP) → design §1.
  - [x] 2.1.6 Add JSDoc invariant block at top of `checkAndConsume`: "MUST remain synchronous — no `await` between bucket read and write; introducing async breaks Req 1.3 atomicity" → spec §1.3; design §2 invariant + §14 risk.
  - [x] 2.1.7 Implement and export `configFromToken(token, defaults?)` resolving `perMinute`, `burst`, `disabled` from token row + env defaults (NULL → default; per-token disable OR kill switch → disabled) → spec §2.1, §5.4; design §4.

- [x] **2.2** Headers helper
  - [x] 2.2.1 Implement and export `withRateLimitHeaders(resp, decision)` in `services/rate-limiter.ts` (or co-located module): clone-and-add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; no-op when `decision === null` or `outcome === 'bypassed'` → spec §3.1, §5.x; design §3, ADR-5.
  - [x] 2.2.2 SSE Response builder in `/v1/chat/completions`: thread `decision: BucketDecision` as a **required** parameter (TS catches missed call sites); bake `X-RateLimit-*` headers into the `headers` object at `new Response(stream, { headers })` construction (NOT post-hoc clone) → spec §3.1.3; design §3 streaming caveat + §14 risk.

- [x] **2.3** Integration in `index.ts` request handler
  - [x] 2.3.1 Define `RATE_LIMITED_PATHS = new Set(['/v1/chat/completions', '/v1/models'])` and `isRateLimitedRoute(pathname)` near top → spec §4.1.6; design §3 Issue B.
  - [x] 2.3.2 Insert rate-limit block after auth + monthly-quota check (~line 1470), gated by `authContext?.type === 'token' && isRateLimitedRoute(url.pathname) && !envDefaults.killSwitch` → spec §4.1; design §3.
  - [x] 2.3.3 Master key + dashboard session bypass: the gating in 2.3.2 (`type === 'token'`) inherently skips master/session; ensure no headers attached on those paths → spec §5.1, §5.2; design §3 route table.
  - [x] 2.3.4 Wire `ratelimitTotal.labels(token.label, decision.outcome).inc()` at call site (NOT inside limiter); on rejection emit `requestLog.info({ tag: 'RateLimit', token_id, token_label, limit, burst, retry_after_seconds }, ...)` → spec §6.1, §6.2; design §9.
  - [x] 2.3.5 Apply `withRateLimitHeaders(resp, decision)` to ALL non-streaming responses on rate-limited paths (200, 4xx, 5xx); SSE path uses 2.2.2 mechanism. Cover the upstream-failover and provider-error legs too → spec §3.1.1, §3.1.2, §3.1.3; design §3 + §14 risk. *Co-changes with 2.5.x in `dashboard.html`? NO — different file; safe to batch separately.*
  - [x] 2.3.6 429 body construction via `errorResponse(429, 'RATE_LIMITED', msg, undefined, corsHeaders, { extras: { retry_after_seconds, limit, remaining: 0, window: 'minute' }, headers: { 'Retry-After': String(retryAfterSeconds) } })`; then wrap with `withRateLimitHeaders` → spec §3.2; design §3.

- [x] **2.4** Admin endpoint changes in `index.ts`
  - [x] 2.4.1 `POST /admin/tokens` accepts optional `ratePerMinute`, `rateBurst` (number | null), `rateLimitDisabled` (boolean, default false). Validate via `validateOptionalNonNegativeInt` helper; reject negatives with 400 `INVALID_REQUEST` → spec §7.1; design §7.
  - [x] 2.4.2 `PATCH /admin/tokens/:id` accepts the same fields with tri-state semantics: `undefined` = leave column, `null` = clear (SET NULL), number = set, `disabled: boolean` = SET 0/1 → spec §7.2; design §7.
  - [x] 2.4.3 `GET /admin/tokens` and `GET /admin/tokens/:id` JSON responses include `ratePerMinute`, `rateBurst` (NULL → JSON `null`), `rateLimitDisabled` (0/1 → JSON boolean) → spec §7.3; design §7.
  - [x] 2.4.4 Extend `createGatewayToken(label, monthlyQuotaTokens?, notes?, rateLimit?)` and `updateGatewayToken` in `services/database.ts` to persist the 3 fields per signatures in design §5 → spec §7.1, §7.2; design §5.

- [x] **2.5** Dashboard UI in `dashboard.html` *(treat 2.5.1–2.5.4 as one batch — same modal section, avoids merge conflicts)*
  - [x] 2.5.1 Add collapsible `<details>` "Rate limit (optional)" section to create/edit token modal → spec §7.4; design §8.
  - [x] 2.5.2 Three inputs inside the section: `ratePerMinute` (number, blank-allowed), `rateBurst` (number, blank-allowed), `rateLimitDisabled` (checkbox). Blank → JSON `null` (NOT 0, NOT empty string) → spec §7.4.1, §7.4.2; design §8.
  - [x] 2.5.3 *Optional, defer if tight:* "Rate" column in token list showing `60/min` (override), `default` (italic gray, NULL), or `disabled` (red) → design §8 (marked optional).
  - [x] 2.5.4 Wire form submit to send the 3 fields in POST/PATCH bodies; verify edit-modal pre-fills from current values → spec §7.4; design §8.

- [x] **2.6** Kill switch wiring
  - [x] 2.6.1 Confirm `envDefaults.killSwitch` (read at module load in 1.4.1 / 2.1.1) gates the `if` in 2.3.2 so `checkAndConsume` is never called when `RATE_LIMIT_DISABLED=1`; counter never increments; headers never attach → spec §5.4; design §4. *Pure wiring verification — no new code beyond the gate already added in 2.3.2.*

---

## Phase 3 — Testing

- [x] **3.1** Test harness selection
  - [x] 3.1.1 Adopt `bun:test` (built-in, zero new deps); add `bun test` script to `package.json` if not present; document choice in a one-line README note → design §15 open question. (README note skipped per Batch G scope; documented in apply-progress.)

- [x] **3.2** Unit tests for `services/rate-limiter.ts` *(grouped by scenario family, NOT one-per-scenario; 50 → ~5 task batches)*
  - [x] 3.2.1 **Bucket math:** steady-state allow under cap, burst exhaustion → reject, refill restores capacity, fractional refill held but only integer consumable, refill clamp at burst, defensive `Math.max(0, elapsed)` clamp on non-monotonic delta → spec §1.1.1–§1.1.6.
  - [x] 3.2.2 **Config resolution:** NULL columns + env defaults → resolved config; per-token override beats env; tri-state: number/null/undefined → spec §2.1.1, §2.1.2, §7.2.x.
  - [x] 3.2.3 **Disabled flag:** per-token `rate_limit_disabled=1` → outcome `'bypassed'`; global `RATE_LIMIT_DISABLED=1` → bypassed; neither increments metric → spec §5.3.1, §5.4.1, §6.1.3.
  - [x] 3.2.4 **Atomicity recipe:** `clearAllBuckets()`, set bucket to 1 token, `Promise.all` of 3 sync `checkAndConsume` calls with same `now` → exactly 1 allowed, 2 rejected (recipe verbatim from design §2) → spec §1.3.1.
  - [x] 3.2.5 **Streaming charge-once + no-refund:** unit-level via 2 sequential consumes simulating start + abort → second consume rejected (no refund), bucket state asserts via `getBucketState` → spec §1.2.2, §1.2.3.

- [ ] **3.3** Integration tests on the request handler — gate at "if hard, skip and document"
  - [ ] 3.3.1 *If feasible:* spin up `Bun.serve` in-test against a fake upstream; hit `/v1/chat/completions` 21× with same token → 20×200 + 1×429 with correct headers and 429 body shape → spec §1.1.2, §3.1, §3.2. (Skipped in Batch G; no harness. Documented in apply-progress.)
  - [x] 3.3.2 *If not feasible* (would require provider mocks for the 200 path): document the skip in a `TESTS.md` note (or README test section); rely on 3.2.x unit coverage + manual smoke test → design §15 open question.

---

## Phase 4 — Documentation

- [x] **4.1** README `### Rate Limiting` section
  - [x] 4.1.1 Document env vars (`RATE_LIMIT_PER_MINUTE_DEFAULT=60`, `RATE_LIMIT_BURST_DEFAULT=20`, `RATE_LIMIT_DISABLED=1`); per-token overrides via admin API; `X-RateLimit-Limit/Remaining/Reset` (delta-seconds, NOT Unix ts — note divergence from GitHub API); 429 body shape and `Retry-After` semantics → spec §2.1, §3.1, §3.2; design §12 ADR-4.
  - [x] 4.1.2 Document caveats from spec §9.3: every restart hands fresh full buckets; gateway is NOT safe to run multi-instance under this design (effective limit becomes N × cap) → spec §9.3.

- [x] **4.2** Observability section
  - [x] 4.2.1 Document `gateway_ratelimit_total{token_label, outcome}` metric; note recommended ceiling ≤50 tokens for cardinality → spec §6.1; design §9.

- [x] **4.3** API reference touch-up
  - [x] 4.3.1 Verify `RATE_LIMITED` row in README error_code table (already added in prior commit); add link to the new Rate Limiting section → spec §9.7.

- [x] **4.4** Operator runbook (inline in README)
  - [x] 4.4.1 `curl` example for `PATCH /admin/tokens/:id` setting `ratePerMinute` per-token → spec §7.2.
  - [x] 4.4.2 Document `RATE_LIMIT_DISABLED=1` as the kill switch (set, restart, all checks skipped) → spec §5.4.

---

## Cross-cutting batching notes (for sdd-apply)

- **Batch A (Phase 1):** 1.1.1 + 1.1.2 + 1.1.3 + 1.2.1 in one go — all in `services/database.ts` and `types.ts`, tightly coupled by compile-time deps.
- **Batch B (Phase 2 core):** 2.1.1–2.1.7 + 2.2.1 in one go — single file `services/rate-limiter.ts`.
- **Batch C (Phase 2 wiring):** 2.3.1–2.3.6 + 2.2.2 + 2.6.1 — all in `index.ts`, share the request-handler scope; splitting risks merge conflicts.
- **Batch D (Phase 2 admin):** 2.4.1–2.4.4 — also `index.ts` + `services/database.ts`; can co-batch with C if scope allows, else sequential.
- **Batch E (Phase 2 UI):** 2.5.1–2.5.4 — single `dashboard.html` modal section; MUST be one batch.
- **Batch F (Phase 1 metric):** 1.3.1 stand-alone in `metrics.ts`; can run anytime before Batch C.
- **Batch G (Phase 3):** 3.1.1 → 3.2.1–3.2.5 → 3.3.x; sequential, gated by Batch B completion.
- **Batch H (Phase 4):** 4.1–4.4; pure README, can run last.
