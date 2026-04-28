# Apply Progress — rate-limit-per-token

## Run 1 — Phase 1 (Batches A + F)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Phase 1 only — Batches A and F per tasks.md cross-cutting batching notes.

### Leaves checked off

- [x] 1.1.1 — three `try { ALTER TABLE gateway_tokens ADD COLUMN ... } catch {}` blocks added to `services/database.ts`, immediately after the two `CREATE INDEX` calls for `gateway_tokens`. Columns: `rate_limit_per_minute INTEGER`, `rate_limit_burst INTEGER`, `rate_limit_disabled INTEGER NOT NULL DEFAULT 0`. Pattern matches existing additive ALTERs at lines 48–53.
- [x] 1.1.2 — `rowToGatewayToken` extended with the three new fields, mirroring the `monthly_quota_tokens` NULL-preserving pattern.
- [x] 1.1.3 — SELECT lists in `findGatewayTokenBySecret` and `listGatewayTokens` extended to include the three new columns.
- [x] 1.2.1 — `GatewayToken` interface in `types.ts` gained `rate_limit_per_minute: number | null`, `rate_limit_burst: number | null`, `rate_limit_disabled: 0 | 1`. `AuthContext` left unchanged (per design §4 / §6).
- [x] 1.3.1 — `ratelimitTotal` Counter registered in `metrics.ts` with labelNames `['token_label', 'outcome']`. Comment notes that bypass paths do not increment.

### Deferred from Phase 1

- 1.4.1 (env defaults parsing) is folded into 2.1.1 per tasks.md; it lives inside `services/rate-limiter.ts` which is created in Batch B. Not applied in this run.

### Typecheck

`bun run typecheck` (= `bunx tsc --noEmit`) — PASS, zero errors.

### Files modified

| File | Lines (approx) | Change |
|------|----------------|--------|
| `services/database.ts` | ~94–99 (new ALTER block after indexes), ~261–276 (rowToGatewayToken), ~284 (findGatewayTokenBySecret SELECT), ~399 (listGatewayTokens SELECT) | Schema migration + read-path mapping |
| `types.ts` | ~190–207 (GatewayToken interface) | Three new optional fields |
| `metrics.ts` | ~59–66 (ratelimitTotal Counter) | New counter registration |

### Notes for next batch (Batch B — `services/rate-limiter.ts`)

1. **`AuthContext` was intentionally NOT extended** — design §4 keeps it narrow. Batch C (`index.ts` integration) must thread the loaded `GatewayToken` through the request-handler scope (it's already in scope after auth) and call `configFromToken(token, envDefaults)` directly rather than reading from `authContext.token.rateLimit`. If Batch B writes `configFromToken` expecting an `AuthContext` shape, it will break.
2. **`createGatewayToken` and `updateGatewayToken` signatures NOT yet changed.** They still take only `(label, monthlyQuotaTokens?, notes?)` and `{ active?, monthlyQuotaTokens?, notes? }` respectively. Leaf 2.4.4 (admin endpoint batch D) is responsible for extending them. Existing INSERT/UPDATE statements do NOT touch the three new columns, so newly-created or PATCHed tokens get the SQL DEFAULT (NULL / NULL / 0) until Batch D lands. For Phase 1 this is correct: tokens resolve to env defaults at runtime via `configFromToken`.
3. **Migration idempotency** — the three `ALTER TABLE` calls each have their own try/catch, so re-running on an already-migrated DB is a no-op (matches Req 8.1.2 / 8.2.1). LibSQL has no `IF NOT EXISTS` for ADD COLUMN; the catch is the idempotency mechanism, consistent with existing code at lines 48–53.
4. **No env vars read yet.** Batch B must add the module-load `envDefaults` constant inside `services/rate-limiter.ts` per design §4 (parses `RATE_LIMIT_PER_MINUTE_DEFAULT`, `RATE_LIMIT_BURST_DEFAULT`, `RATE_LIMIT_DISABLED`).

### Risks for next batches

1. **Atomicity invariant in `checkAndConsume`.** Per design §2 / §14: introducing any `await` between bucket read and write breaks Req 1.3. Batch B must include the JSDoc invariant block at the top of `checkAndConsume` (leaf 2.1.6) — easy to omit.
2. **SSE header attachment.** Per design §3 / §14 risk: Batch C must build the streaming `Response` with `X-RateLimit-*` headers baked into the constructor `headers` object, not via a post-hoc clone of a streaming Response. Leaf 2.2.2 makes `decision` a required parameter on the SSE response builder so TS catches missed call sites.

---

## Run 2 — Phase 2 (Batch B)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch B per tasks.md cross-cutting batching notes — pure rate-limiter module, no integration.

### Leaves checked off

- [x] 1.4.1 — `envDefaults` constant defined at module load inside `services/rate-limiter.ts`. Parses `RATE_LIMIT_PER_MINUTE_DEFAULT` (fallback 60) and `RATE_LIMIT_BURST_DEFAULT` (fallback 20) with `Number.isFinite && > 0` guard so `0`, `NaN`, negatives all fall back to defaults. `killSwitch = process.env.RATE_LIMIT_DISABLED === '1'`. Exposed via `getEnvDefaults()`. (Folded into 2.1 per tasks.md note.)
- [x] 2.1.1 — `BucketConfig`, `BucketDecision`, `BucketState`, `EnvDefaults` interfaces defined per design §1. `const buckets = new Map<number, BucketState>()` instantiated at module scope.
- [x] 2.1.2 — `checkAndConsume(tokenId, _label, config, now?)` implemented fully synchronous. Lazy refill via `(elapsedMs / 1000) * refillPerSec`; `Math.max(0, elapsedMs)` clamp on the delta (spec §1.1.6); `Math.min(config.burst, …)` cap on tokens (spec §1.1.5); allow path decrements 1; reject path computes `retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / refillPerSec))` (spec §3.2.3).
- [x] 2.1.3 — `now: number = performance.now()` default parameter. Caller can inject for tests.
- [x] 2.1.4 — `config.disabled` short-circuits to `{ allowed: true, outcome: 'bypassed', remaining: config.burst, resetSeconds: 0, retryAfterSeconds: 0 }`. No bucket touched, no decrement, and `withRateLimitHeaders` no-ops on this outcome (header omission is the wire-level signal of bypass per spec §5.3.1).
- [x] 2.1.5 — `getBucketState(tokenId): Readonly<BucketState> | undefined` and `clearAllBuckets(): void` exported.
- [x] 2.1.6 — JSDoc invariant block placed directly above `checkAndConsume`. States the synchronous-mutation invariant verbatim and lists the three correct migration paths (atomic SQL UPDATE, async lock, Redis Lua) for any future maintainer who wants to make state shared/persistent.
- [x] 2.1.7 — `configFromToken(t, defaults = envDefaults)` resolves the three fields. NULL columns fall back to defaults; per-token `rate_limit_disabled === 1` OR `defaults.killSwitch` → `disabled: true`.
- [x] 2.2.1 — `withRateLimitHeaders(resp, decision)` clones the response (`new Response(resp.body, { status, statusText, headers })`) and sets the three `X-RateLimit-*` headers. No-op on `decision === null` or `outcome === 'bypassed'`. JSDoc explicitly notes (a) `Retry-After` is added at the 429 call site, not here; (b) SSE responses MUST NOT use this helper — bake headers at constructor time per design §3 streaming caveat.

### Deferred to Batch C

- 2.2.2 (SSE response builder threading `decision` as a required parameter) — lives in `index.ts` (the chat-completions handler). Per the assignment note and tasks.md "Cross-cutting batching" §C, this is part of Batch C.

### Implementation deviations from design

None of substance. Two minor stylistic choices:
1. `checkAndConsume` was refactored from the design's two distinct return blocks into a single computed return (allow vs reject share the `resetSeconds` formula), purely to keep the module under the 150-line guideline. Behavior is bit-for-bit identical to design §2 pseudocode.
2. Added a defensive `Math.max(0, …)` on `state.tokens + refillTokens` before the `Math.min(burst, …)` cap. Belt-and-suspenders against a hypothetical future bug that produces a negative refillTokens; not required by any spec scenario but cheap.
3. The `_label` parameter on `checkAndConsume` is currently unused inside the limiter (metrics increment is at the call site per design §9). Underscore-prefix marks it as "intentionally accepted but not consumed" so TS strict doesn't flag, while preserving the design §1 signature shape so Batch C's call site reads symmetrically.

### Typecheck

`bun run typecheck` — PASS, zero errors. Module compiles standalone (only import is `GatewayToken` from `../types`, already exported with the three new fields by Run 1).

### File created

| File | Lines | Purpose |
|------|-------|---------|
| `services/rate-limiter.ts` | 146 | Pure module: types, `envDefaults`, `getEnvDefaults`, `configFromToken`, `checkAndConsume`, `withRateLimitHeaders`, `getBucketState`, `clearAllBuckets`. No imports of `metrics.ts`, `logger.ts`, or `index.ts` — observability and integration deferred to Batch C. |

### Risks for Batch C (`index.ts` integration)

1. **`withRateLimitHeaders` returns a NEW `Response`; the original is discarded.** Batch C must use the return value: `resp = withRateLimitHeaders(resp, rlDecision)` — NOT `withRateLimitHeaders(resp, rlDecision)` as a statement. Easy mistake to make at the multiple `return resp` points inside the chat-completions handler. Recommend: wrap at the outermost `return` of the handler, not at every intermediate `resp = …`.
2. **SSE path MUST bypass `withRateLimitHeaders` entirely.** Per design §3 streaming caveat and the JSDoc on the helper, a streaming `Response` cannot be safely cloned (body-stream affinity). Batch C / leaf 2.2.2 must thread `decision` into the SSE Response constructor and set `X-RateLimit-Limit/Remaining/Reset` on the `headers` object passed to `new Response(stream, { headers })`. The TS compiler will help if `decision: BucketDecision` is made a **required** (non-optional) parameter on the SSE builder.
3. **Bonus risk (kill switch):** the gate in 2.3.2 is `!envDefaults.killSwitch`. If Batch C imports `envDefaults` directly via the not-exported constant, that won't compile. Use `getEnvDefaults()` (exported) or import the `EnvDefaults` shape and call once at handler module load. The current export is `getEnvDefaults()` — Batch C should call it once at top-level so the kill-switch read is module-load-stable.

---

## Run 3 — Phase 2 (Batch C)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch C per tasks.md cross-cutting batching notes — `index.ts` request-handler integration only. Admin endpoints (Batch D) and dashboard UI (Batch E) untouched.

### Leaves checked off

- [x] 2.2.2 — SSE Response in `/v1/chat/completions` (line ~2613 of post-edit `index.ts`) now bakes `X-RateLimit-Limit/Remaining/Reset` directly into the `sseHeaders` object at `new Response(stream, { headers: sseHeaders })`. No clone, no `withRateLimitHeaders` on the streaming path. Headers are conditionally added only when `rateLimitDecision && outcome !== 'bypassed'`. The streaming response is constructed inline (not via a helper function), so the "required TS parameter" mechanism degenerated to a single inline gate; the same TS-fail-on-missed-call-site safety is achieved by the `rateLimitDecision` being a single function-scoped variable that the inline construction reads directly — there are no other SSE construction sites.
- [x] 2.3.1 — `RATE_LIMITED_PATHS = new Set(['/v1/chat/completions', '/v1/models'])` defined at module top (line ~67), right after the rate-limit imports and `rateLimitEnvDefaults`. Used as `RATE_LIMITED_PATHS.has(url.pathname)` — no separate `isRateLimitedRoute` helper, since the Set's `.has` is the same one-liner.
- [x] 2.3.2 — Rate-limit block inserted at lines 1495–1554 (post-edit), immediately after the closing `}` of the `if (requiresAuth)` block and before the admin endpoint dispatch. Gating: `!rateLimitEnvDefaults.killSwitch && authContext?.type === 'token' && authedToken && RATE_LIMITED_PATHS.has(url.pathname)`. The `authedToken` capture is new — see "Implementation deviations" below.
- [x] 2.3.3 — Master + dashboard-session bypass is enforced by the `authContext?.type === 'token'` guard in the gating expression. Both master-key bearer and dashboard-session resolve to `authContext.type === 'master'` and skip the block entirely; no `X-RateLimit-*` headers are attached on their paths because `rateLimitDecision` stays `null` and the `respond()` helper / SSE inline check both no-op when null.
- [x] 2.3.4 — `ratelimitTotal.inc({ token_label, outcome })` is called at the call site, NOT inside the limiter. Only the `'allowed' | 'rejected'` outcomes increment; `'bypassed'` short-circuits via the `if (decision.outcome !== 'bypassed')` guard so per-token disabled flag and kill switch (the latter is gated even earlier) do not pollute metric cardinality. On rejection, a `requestLogger`-derived child log fires at `info` with the six required fields (`tag`, `token_id`, `token_label`, `limit`, `burst`, `retry_after_seconds`).
- [x] 2.3.5 — Non-streaming responses on `/v1/chat/completions` are wrapped via a local `respond(resp)` helper inside the chat-completions handler, defined right after the `decrementInFlight` closure. The helper closes over `rateLimitDecision` and calls `withRateLimitHeaders(resp, rateLimitDecision)` — bypass paths return the response unchanged. Wrapped sites: invalid-messages 400 (line ~1782), no-compatible-provider 400 (line ~1880), unknown-pinned 400 (line ~1908), pinned circuit-open 503 (line ~1927), non-streaming success 200 (line ~2042), all-providers-failed 502 (line ~2113), outer-catch 500 (line ~2628). `/v1/models` GET uses `withRateLimitHeaders` directly (no closure needed since the 200 is the only return).
- [x] 2.3.6 — 429 path goes through `errorResponse(429, 'RATE_LIMITED', message, 'rate_limit_error', corsHeaders, { extras, headers })` and is then wrapped by `withRateLimitHeaders(..., decision)`. Note the 4th parameter (`type`) is `'rate_limit_error'` (matches existing OpenAI-compatible `type` strings used elsewhere) rather than the `undefined` shown in the prompt's pseudocode — `errorResponse` defaults to `'gateway_error'` if undefined, but `'rate_limit_error'` is more descriptive and consistent with `'authentication_error'`, `'invalid_request_error'`, etc. used elsewhere in the file. Body shape exactly matches spec §3.2.1: `error.code='RATE_LIMITED'`, `retry_after_seconds`, `limit`, `remaining: 0`, `window: 'minute'`. `Retry-After` lives in `options.headers`. `X-RateLimit-*` are added by the wrapper.
- [x] 2.6.1 — Kill switch verified: `rateLimitEnvDefaults.killSwitch` is the FIRST term of the gate's `&&` chain. When set, the entire block is skipped — `checkAndConsume` is never called, the metric never increments, `rateLimitDecision` stays `null`, `respond()` no-ops, SSE inline check no-ops. Pure wiring verification, no new code.

### Implementation deviations from prompt's plan

1. **`AuthContext` was deliberately NOT extended** (per Batch B's explicit note). Instead, a new request-scoped `let authedToken: GatewayToken | null = null` was added beside `let authContext`. Inside the existing `else if (!authContext && bearer && !adminOnlyPath)` arm, after the existing `authContext = { ... }` assignment, we now also do `authedToken = token;`. This captures the full row in handler scope at zero cost (it was already loaded by `findGatewayTokenBySecret`). The rate-limit block reads `authedToken` directly — no DB re-read. This matches design §4 ("`AuthContext` does NOT need a new field").
2. **No separate `isRateLimitedRoute` helper.** The prompt and design suggested a helper function; in practice `RATE_LIMITED_PATHS.has(url.pathname)` is one expression, identical in clarity, and avoids a one-line wrapper. Drop is purely stylistic; no behavior change.
3. **`respond()` helper local to the chat-completions handler.** Rather than wrapping at every `return` point with `withRateLimitHeaders(resp, rateLimitDecision)`, an arrow function `respond = (resp) => withRateLimitHeaders(resp, rateLimitDecision)` is defined once near the top of the handler's `try` block. All non-streaming returns go through `respond(...)`. Reads more cleanly than threading `rateLimitDecision` into seven call sites and the diff is smaller. Minor: this means the helper also fires on master-key requests to `/v1/chat/completions` (which the prompt's smoke-test mentally explicitly forbids), but `withRateLimitHeaders` no-ops when `decision === null`, which is exactly the master-key case here (because the gating block earlier never ran for `type === 'master'`). Verified by reading the helper logic.
4. **Inline SSE header bake instead of refactoring the response builder.** The SSE construction in `index.ts` is inline (not a function), so threading `decision` as a "required TS parameter" devolves to a `Record<string, string>` headers object built right before `new Response(stream, { headers: sseHeaders })`. Identical net effect: headers are baked at constructor time, no clone, single source of truth.
5. **`requestLogger` invocation for the rate-limit reject log.** The block is module-handler-scope, where there is no pre-existing `log` in scope (the chat-completions handler has its own scoped `log`, but the rate-limit block executes BEFORE that handler is entered). We construct a fresh `requestLogger(crypto.randomUUID(), { path, method })` for the single rejection log line. Trace ID is local to the rejection — clients don't currently get it back via a header, but the 429 returns immediately so cross-trace correlation isn't a concern. If a future change adds `X-Trace-Id` to all responses, this rate-limit reject log can adopt the same trace ID by lifting `traceId` allocation up to the request handler entry. (Not in scope here.)

### Files modified

| File | Approx line ranges | Change |
|------|-------------------|--------|
| `index.ts` | 31–61 (imports), 64–71 (`rateLimitEnvDefaults` + `RATE_LIMITED_PATHS`), 1389 (`authedToken` declaration), 1480 (`authedToken = token` capture), 1495–1554 (rate-limit block), 1697–1707 (`/v1/models` wrap), 1745–1751 (`respond` helper inside chat-completions), 1782/1880/1908/1927/2042/2113/2628 (wrap each non-streaming `return` with `respond(...)`), 2613–2624 (SSE inline header bake) | Rate-limit integration |

### Typecheck

`bun run typecheck` (= `bunx tsc --noEmit`) — PASS, zero errors.

### Smoke-test mental walk-through (matches the prompt's checklist)

- Master-key request to `/v1/chat/completions`: `requiresAuth=true`, `authContext.type='master'`, the rate-limit block's `authContext?.type === 'token'` guard fails → `rateLimitDecision` stays `null` → `respond(...)` and SSE inline check both no-op → no `X-RateLimit-*` headers. ✓
- Token request to `/health`: `requiresAuth=false` (path-skip), `authContext` stays `null` → block skipped → no headers. ✓
- Token request to `/v1/models`: gate passes → `checkAndConsume` runs → `rateLimitDecision` set → `withRateLimitHeaders(...)` adds the 3 headers. ✓
- Token request to `/v1/chat/completions` over budget: gate passes → `decision.allowed === false` → 429 path returns immediately with body, `Retry-After`, and three `X-RateLimit-*` headers (added by wrapper). ✓
- Token with `rate_limit_disabled=1`: `configFromToken` returns `disabled: true` → `checkAndConsume` short-circuits to `outcome: 'bypassed'` → call-site guard `decision.outcome !== 'bypassed'` keeps `rateLimitDecision` null → no metric inc, no headers. ✓
- Env `RATE_LIMIT_DISABLED=1`: `rateLimitEnvDefaults.killSwitch === true` → entire block skipped (first term of `&&` chain) → no `checkAndConsume`, no metric, no headers. ✓
- Token request to `/v1/does-not-exist`: not in `RATE_LIMITED_PATHS` → block skipped → falls through to the final `return new Response('Not Found', { status: 404, headers: corsHeaders })` at line ~2660 → no headers, no consume. ✓

### Risks for downstream batches

1. **Batch D (admin endpoints) extends `index.ts` again.** The auth block now references `authedToken` — Batch D's `POST /admin/tokens` and `PATCH /admin/tokens/:id` extend `createGatewayToken`/`updateGatewayToken` signatures; merge-conflict surface is in `services/database.ts` (signatures) plus the existing admin endpoint blocks (~lines 1542, 1622). The rate-limit block insertion (lines 1495–1554) sits BEFORE the admin endpoints; Batch D should not need to touch those lines. Caveat: if Batch D wants to surface the new rate-limit fields on a master-keyed `GET /admin/tokens/:id` self-inspect, they're already mapped in `rowToGatewayToken` (Batch A) — Batch D just needs to pass them through in the response JSON.
2. **Verification phase must mentally re-confirm the 429 response shape.** The prompt's pseudocode in the leaf 2.3.6 description used `errorResponse(429, 'RATE_LIMITED', msg, undefined, corsHeaders, options)`. We pass `'rate_limit_error'` as the 4th argument (the `type` field) instead of `undefined`. This is a STYLE deviation, not a behavior deviation: the 4th arg defaults to `'gateway_error'` if undefined, neither of which appears in spec §3.2.1's required body (which only fixes `error.code`, `message`, `retry_after_seconds`, `limit`, `remaining`, `window`). The `type` field is a free-form OpenAI-compat string. Verification should assert `error.code === 'RATE_LIMITED'` and the six body keys from spec §3.2.1, NOT `error.type`.
3. **The `respond()` helper is local to the chat-completions handler.** If a future change adds another `/v1/*` rate-limited path (e.g. `/v1/embeddings`) and forgets to either (a) wire its handler's returns through `withRateLimitHeaders` or (b) add it to `RATE_LIMITED_PATHS`, the headers won't appear on its responses. Mitigation: this is what the cross-cutting checklist in design §3 ("when future routes are added, they MUST be added to the set explicitly") is for; verify-phase integration test should cover an added route.

---

## Run 4 — Phase 2 (Batch D)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch D per tasks.md cross-cutting batching notes — admin endpoint surface (`POST` / `GET` / `PATCH /admin/tokens[/:id]`) plus the matching `services/database.ts` CRUD signatures. Dashboard UI (Batch E) untouched.

### Leaves checked off

- [x] 2.4.1 — `POST /admin/tokens` now accepts `ratePerMinute` (number | null | absent), `rateBurst` (number | null | absent), `rateLimitDisabled` (boolean, default `false`). A local `validateOptionalNonNegativeInt` arrow function inside the handler returns either `number | null` (success: absent or null collapse to `null` for the create path) or `{ error }` on bad input; the handler dispatches a 400 `INVALID_REQUEST` (`'invalid_request_error'` type) with the validator's message. `rateLimitDisabled` is type-checked separately as `boolean` (with a 400 if a non-boolean was sent). The validator was inlined rather than hoisted to a top-level helper because its only consumer is this single handler — the PATCH handler needs different return semantics (tri-state: `undefined | null | number`). Hoisting would mean two different helpers anyway.
- [x] 2.4.2 — `PATCH /admin/tokens/:id` accepts the same three fields with strict tri-state semantics:
  - **`undefined` (key absent from body) → leave column as-is** (no SET clause emitted by `updateGatewayToken`).
  - **`null` (explicit JSON null) → SET column = NULL** (clear the override; runtime resolves to env default).
  - **integer ≥ 0 → SET column = value**.
  - **`rateLimitDisabled: boolean` → SET column = 0/1**.

  A separate `validateRate` arrow function inside the handler returns a discriminated union `{ ok: true; value: number | null | undefined } | { ok: false; error }`. The handler then uses the JS `'key' in body` operator to distinguish "key absent" from "key explicitly set to undefined" — the former skips the SET clause; the latter would (in valid JSON) be impossible since JSON parses `undefined` as nothing. The body type extension and the `changes` object construction both preserve this tri-state.
- [x] 2.4.3 — `GET /admin/tokens` response now projects each token row through a small `tokens.map(t => ({ ...t, ratePerMinute, rateBurst, rateLimitDisabled }))` transform. `ratePerMinute` and `rateBurst` are direct passthroughs from the snake_case columns (NULL → JSON `null`). `rateLimitDisabled` converts `0 | 1` to `true | false`. Existing snake_case fields are **also kept** in the response (spread first, then add the camelCase keys) to avoid breaking any consumer of the current dashboard.html which reads e.g. `t.monthly_quota_tokens` directly. This is a non-destructive widening: legacy readers see no change, new readers (Batch E) get the camelCase per spec §7.3. There is no separate `GET /admin/tokens/:id` handler in the existing `index.ts` (only the LIST endpoint plus the `tokenByIdMatch` regex which routes only `DELETE`/`PATCH`), so 2.4.3 is satisfied entirely by the LIST update — the "if exists" caveat in tasks.md anticipated this.
- [x] 2.4.4 — `createGatewayToken` and `updateGatewayToken` signatures extended in `services/database.ts`:
  - `createGatewayToken(label, monthlyQuotaTokens?, notes?, rateLimit?)` — new optional `rateLimit?: { perMinute?, burst?, disabled? }` block. INSERT statement now includes the three new columns; `null` and `undefined` both persist as NULL for the integer fields, `true/false` map to 1/0 for `disabled`, and `Math.max(0, Math.floor(…))` is applied as a defensive coerce on the integer fields (matches the existing pattern for `monthlyQuotaTokens`).
  - `updateGatewayToken(id, changes)` — `changes` extended with `ratePerMinute?: number | null`, `rateBurst?: number | null`, `rateLimitDisabled?: boolean`. SET-clause builder emits one clause per explicitly-present key (the `!== undefined` check already used for the existing fields), so `undefined` correctly skips the column. Order of SET clauses matches order of changes object — purely cosmetic since SQL UPDATE is set-based.

### Implementation deviations from prompt's plan

1. **GET response keeps snake_case fields alongside the new camelCase ones.** Spec §7.3 mandates camelCase keys (`ratePerMinute`, `rateBurst`, `rateLimitDisabled`) but the existing GET response emits the entire `GatewayToken` shape directly via `JSON.stringify(tokens)`, which uses snake_case (`monthly_quota_tokens`, `notes`, etc.) and is consumed by the existing dashboard.html (e.g. `t.monthly_quota_tokens` at lines 1996–2033). Cleanest non-breaking path: the projection adds the three camelCase keys *in addition to* the existing snake_case ones (spread first). Batch E (dashboard form) will read/write the camelCase form per spec; legacy snake_case display code in dashboard.html keeps reading `t.monthly_quota_tokens` and friends untouched. **Risk for Batch E:** the form submit must send `ratePerMinute` / `rateBurst` / `rateLimitDisabled` (not snake_case) — the POST/PATCH handlers only accept the camelCase forms.
2. **Validator inlined per handler, not hoisted.** Two reasons: (a) POST and PATCH need different return shapes (POST collapses absent + null to null; PATCH must distinguish them). (b) Existing index.ts has zero validator helpers at module scope; inlining matches the prevailing inline-typeof-checks style at lines 1568, 1686, etc. A future refactor could extract a shared `validateOptionalNonNegativeInt` helper in `errors.ts` if more endpoints need it, but for now the duplication is two lines and self-documenting.
3. **`'key' in body` operator for tri-state in PATCH.** JS does NOT distinguish `{ ratePerMinute: undefined }` from `{}` after JSON parse, but it DOES distinguish `{ ratePerMinute: null }` from `{}`. The PATCH handler uses `'ratePerMinute' in (body ?? {})` to detect the key being explicitly present — even when its value is `null`. This is the canonical JS idiom for "did the caller send this field at all?" and matches the spec §7.2.2 contract ("Explicit `null` MUST clear the override").
4. **No singular `GET /admin/tokens/:id` was added.** The `tokenByIdMatch` block only handles DELETE and PATCH. Adding a GET is not required by spec §7.3 (which says "GET `/admin/tokens` and `GET /admin/tokens/:id` (if exists)") and is out of Batch D scope per the task prompt. If the dashboard ever needs a single-token detail view, it can be added in a follow-up (read directly via `findGatewayTokenBySecret` is wrong — would need a `findGatewayTokenById`; not present in services/database.ts today).
5. **POST response now includes the three new fields in the 201 body.** Returning the resolved values so the dashboard can immediately reflect them in its create-confirmation modal without a re-fetch. Echoes the existing pattern of the POST response surfacing `monthlyQuotaTokens` (line 1582 of pre-edit). For consistency: `ratePerMinute` and `rateBurst` are echoed as the post-validation values (so a `null` body → `null` in response, an integer → that integer); `rateLimitDisabled` is echoed as the resolved boolean.

### Files modified

| File | Approx line ranges | Change |
|------|-------------------|--------|
| `services/database.ts` | 368–404 (`createGatewayToken` signature + INSERT), 441–500 (`updateGatewayToken` signature + SET-clause builder) | Persist the 3 new fields; tri-state UPDATE semantics. |
| `index.ts` | ~1558–1622 (POST handler), ~1624–1648 (GET handler with projection), ~1690–1758 (PATCH handler with tri-state) | Body parsing, validation, response shape; rate-limit fields surfaced in camelCase per spec §7.3. |

### Typecheck

`bun run typecheck` (= `bunx tsc --noEmit`) — PASS, zero errors.

### Risks for Batch E (dashboard.html)

1. **POST/PATCH handlers ONLY accept camelCase.** Batch E's form submit MUST send `ratePerMinute`, `rateBurst`, `rateLimitDisabled` keys (NOT snake_case). The POST/PATCH body type definitions explicitly only declare these three keys for the rate-limit fields; any snake_case key sent by the form would be silently ignored (TS doesn't catch runtime body shape, and the destructure reads only the camelCase keys).
2. **Blank input → JSON `null`, NOT `0` or empty string.** Per spec §7.4.1 + scenario 7.4.1: a blank rate-per-minute input must serialize to `"ratePerMinute": null` in the POST/PATCH body. The validator REJECTS empty string with a 400 (`typeof v !== 'number'` after the null/undefined gate). If Batch E sends `""`, the user sees a confusing 400 error. Same for `rateBurst`. The dashboard form submit should explicitly map `input.value === ''` → `null` before stringifying.
3. **GET response has BOTH snake_case and camelCase.** Batch E should pre-fill the edit modal from the camelCase fields (`t.ratePerMinute`, `t.rateBurst`, `t.rateLimitDisabled`) — the snake_case fields remain in the response purely to avoid breaking the existing legacy display code in dashboard.html. Mixing the two in new code would be confusing; pick the camelCase variant for any new dashboard field that touches rate-limit.
4. **`rateLimitDisabled` is BOOLEAN in the response, not 0/1.** The list response converts via `t.rate_limit_disabled === 1`. The edit modal checkbox should bind directly to that boolean (no `=== 1` comparison needed when reading from the camelCase field).

---

## Run 5 — Phase 2 (Batch E)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch E per tasks.md cross-cutting batching notes — `dashboard.html` only. Backend (Batches A–D) and rate-limiter module untouched.

### Leaves checked off

- [x] 2.5.1 — Collapsible `<details class="form-collapsible">` "Rate limit (optional)" section added inside both the **create** modal (after the notes input, before `.form-actions`) and the **edit** modal (after the active-checkbox group, before `.form-actions`). Edit modal auto-opens the section if any of the three fields is set on the loaded token (`hasRateOverride` check), so the user immediately sees the override.
- [x] 2.5.2 — Three inputs inside the body: `tf-rate-per-min` / `tf-rate-burst` (`<input type="text" inputmode="numeric">`, blank-allowed; placeholder reads "Blank uses gateway default") and `tf-rate-disabled` (`<input type="checkbox">` rendered inside a `.checkbox-row` label). The text-input choice mirrors the existing monthly quota input (`tf-quota`) — text + `inputmode="numeric"` was already the project convention so the styling lands without any new CSS branching. Blank-input handling is explicit: `value === ''` → `null` in the JSON body. Numeric input is parsed via `Number(raw.replace(/[, _]/g, ''))` to mirror the existing quota parser, then floored. Negative or NaN triggers a toast and aborts the submit (defense-in-depth — the backend validator would also reject, but a client-side toast is friendlier than a 400).
- [x] 2.5.3 — "Rate" column ADDED to the token list (not skipped). Header row gains a `<th>Rate</th>` between "This month" and "Last used". Each row renders one of three small spans:
  - `<span class="rate-cell is-disabled">disabled</span>` (red, when `rateLimitDisabled === true`)
  - `<span class="rate-cell is-override">{N}/min · burst {M}</span>` (mono, default text color, when `ratePerMinute != null`)
  - `<span class="rate-cell is-default">default</span>` (italic, muted, when both nullable fields are null and not disabled)
  Column adds ~80 px to the existing 7-column table; visual width was acceptable on a 1280-wide viewport in the Launch preview panel. If a future high-density row ever overflows, the `.rate-cell` span sets `white-space: nowrap` so the cell collapses gracefully via the table layout, not the text.
- [x] 2.5.4 — Form submit wired in both POST (create) and PATCH (edit) flows. Both flows send the **camelCase** keys (`ratePerMinute`, `rateBurst`, `rateLimitDisabled`) per Batch D's risk #1. Tri-state for PATCH: the form **always sends** all three keys, with `null` for blank inputs. This matches Batch D's risk #2 ("blank → null, NOT empty string") and matches design §7's "explicit null clears the override" semantic — the user emptying the input is the explicit clear gesture. Edit-modal pre-fill reads from `t.ratePerMinute` / `t.rateBurst` / `t.rateLimitDisabled` (camelCase, per Batch D's risk #3 + #4). Pre-fill values are wired through new `data-rate-per-min` / `data-rate-burst` / `data-rate-disabled` attributes on the edit button, then unpacked in the click handler — same pattern as the existing `data-quota` plumbing.

### Implementation deviations from prompt's plan

1. **Text input + `inputmode="numeric"`, NOT `<input type="number">`.** The prompt plan suggested `type="number"`. Project precedent is `type="text" inputmode="numeric"` (see `tf-quota` and `tef-quota` lines that already exist). Switching just the rate-limit inputs to `type="number"` would have introduced a visual mismatch in modal height + a different mobile keyboard than the rest of the dashboard. Behavioral identical for our needs (both produce a string we have to parse).
2. **The "Rate" column was implemented, not skipped.** The leaf was marked optional with a "skip if too wide" caveat. After adding it the table fits comfortably in the modal+page container at 1280 px wide; the column adds ~80 px and the rate cell uses `white-space: nowrap` so it never wraps weirdly. Skip path was unnecessary.
3. **Edit modal auto-opens the `<details>` if an override is set.** The plan called this out as nice-to-have ("Open the `<details>` element if any of the values are set"); fully implemented via a `hasRateOverride` check before rendering, then a literal `open` attribute on the `<details>`. This avoids the user wondering "where are my values?" when reopening a token they previously customized.
4. **Two-stage pre-fill: dataset → object → modal.** The existing `openTokenEditModal(t)` is called from the `data-edit-token` button click handler with a hand-built `t` object (not the GET response row). Three new dataset attributes were added to that button, then unpacked in the click handler exactly mirroring the `monthly_quota_tokens` plumbing. No change to the data flow shape; the modal still receives a plain object. (Alternative would be passing the full row from the cached `state.tokens` array; rejected to keep this batch's diff minimal.)
5. **Negative-value validation client-side.** Added `n < 0` toast for both rate inputs as defense-in-depth. The Batch D `validateOptionalNonNegativeInt` server-side validator is the source of truth; the client-side check just shortcuts a 400 round-trip with a more specific message.

### Files modified

| File | Approx line ranges (post-edit) | Change |
|------|-------------------------------|--------|
| `dashboard.html` | 455–469 (CSS for `.form-collapsible`, `.checkbox-row`, `.rate-cell`) | New utility classes for collapsible section + rate column |
| `dashboard.html` | ~1980–1985 (table head adds `<th>Rate</th>`) | New column header |
| `dashboard.html` | ~1991–2003 (`rateCell` const + `<td>${rateCell}</td>` + 3 new `data-rate-*` attrs on edit button) | Rate cell rendering + dataset plumbing for edit pre-fill |
| `dashboard.html` | ~2034–2046 (edit-button click handler unpacks the 3 new dataset attrs) | Pre-fill plumbing |
| `dashboard.html` | ~2074–2090 (create modal: `<details>` block) | New collapsible markup |
| `dashboard.html` | ~2103–2138 (create submit handler reads 3 inputs, builds POST body) | camelCase POST body |
| `dashboard.html` | ~2188–2218 (edit modal: `<details>` block with `${hasRateOverride ? 'open' : ''}` + value pre-fill) | New collapsible markup with auto-open |
| `dashboard.html` | ~2235–2266 (edit submit handler reads 3 inputs, builds PATCH body) | camelCase PATCH body |

### Typecheck

`bun run typecheck` (= `bunx tsc --noEmit`) — PASS, zero errors. (Expected: dashboard.html has no TS — but the typecheck still confirms no upstream breakage from concurrent edits.)

### HTML/JS sanity checks

- Backtick count across the file: 172 (even — template-literal-balanced).
- Two `<details>` elements (create modal + edit modal) — verified via `grep -c '<details' dashboard.html`.
- 13 references to `form-collapsible` — CSS rules + markup usages.
- 23 hits for `ratePerMinute|rateBurst|rateLimitDisabled` across the file — covers CSS-free names: list rendering, dataset, edit-button handler, create modal HTML, create submit, edit modal HTML, edit submit.

### Smoke-test mental walk-through

- **Create token, leave rate fields blank:** `tf-rate-per-min.value === ''`, `tf-rate-burst.value === ''`, `tf-rate-disabled.checked === false` → POST body `{ ..., ratePerMinute: null, rateBurst: null, rateLimitDisabled: false }`. Backend (Batch D) accepts → DB row has `rate_limit_per_minute=NULL`, `rate_limit_burst=NULL`, `rate_limit_disabled=0`. Token resolves to env defaults at runtime. ✓ (matches spec §7.4.1)
- **Create token, fill 30/10:** POST body `{ ..., ratePerMinute: 30, rateBurst: 10, rateLimitDisabled: false }`. DB row has the override. Token gets 30/min × burst 10. ✓ (matches spec §7.4.2)
- **Create token, check disabled:** POST body has `rateLimitDisabled: true`. DB row has `rate_limit_disabled=1`. Limiter short-circuits to `bypassed` outcome. ✓
- **Edit token that has override:** GET response includes `t.ratePerMinute=30`, `t.rateBurst=10`, `t.rateLimitDisabled=false` → list rendering shows `30/min · burst 10` cell → edit button has `data-rate-per-min="30"`, `data-rate-burst="10"`, `data-rate-disabled="0"` → click unpacks to modal call → `hasRateOverride === true` → `<details open>` → inputs pre-filled. User clears the rate-per-min input + saves → PATCH body `{ ..., ratePerMinute: null, rateBurst: 10, rateLimitDisabled: false }` → backend Batch D PATCH "key present with null" → SET `rate_limit_per_minute=NULL` → token now resolves to env default for per-minute, keeps burst=10. ✓ (matches spec §7.2.2 + design §7 tri-state)
- **Edit token with no override:** GET response has all three fields null/false → list rendering shows italic "default" cell → edit button data attrs blank/0 → modal opens with `<details>` collapsed → user can expand to add an override. ✓

### Risks for verify phase / production smoke test

1. **`<details>` browser support assumption.** All evergreen browsers (Chrome, Firefox, Safari, Edge) support `<details>` natively since 2014. The dashboard's other CSS already uses features (`backdrop-filter`, `:has`, etc.) that are at least as recent, so this is consistent. If the dashboard is ever opened in a hyper-old corporate browser, the `<details>` element would still display its content but without the toggle (graceful degradation — the rate-limit fields are simply always visible). No JS fallback needed.
2. **Tri-state PATCH semantics depend on the user's mental model.** The form **always** sends the three rate-limit keys on Update — there is no "leave field unchanged" UI. This is a deliberate design choice (matches design §7's blank=null=clear semantic and avoids dirty-state tracking complexity), but if the GET response in production ever returns stale or partial values, an inadvertent Update click would clobber whatever the user couldn't see. Mitigation: the modal always pre-fills from the response, and the response is the latest GET — so what the user sees IS what they will save. Verify-phase integration test (or manual smoke) should confirm: open edit modal on a token with `ratePerMinute=30` set, click Update without changing anything → DB still has `rate_limit_per_minute=30` (not NULL). The current code achieves this because the input is pre-filled to "30", which serializes back as 30, not as null.

---

## Run 6 — Phase 3 (Batch G)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch G per tasks.md — test harness + rate limiter unit tests; integration test skipped and documented.

### Leaves checked off

- [x] 3.1.1 — Adopted `bun:test` (built-in). Added `"test": "bun test"` to `package.json`. README note was skipped per Batch G scope restriction.
- [x] 3.2.1 — Bucket math unit tests added (8 tests): burst allow, burst reject, 1s refill allow, 500ms fractional reject, 1500ms fractional allow then reject, burst clamp, non-monotonic clamp, retryAfter/reset math on rejection.
- [x] 3.2.2 — Config resolution tests added (4 tests): null fallback, per-token override, per-token disabled, killSwitch via injected defaults.
- [x] 3.2.3 — Disabled flag behavior tests added (2 tests): bypass does not create bucket, repeated bypass.
- [x] 3.2.4 — Atomicity test added (1 test): race for last token yields exactly one allowed.
- [x] 3.2.5 — Streaming semantics tests added (1 test): no refund on abort (second consume rejected).

### Skipped / deferred

- **Global kill switch unit test at module-load** was not implemented (requires module reset or process-level env injection). The config contract for kill-switch is still covered via injected defaults in the config resolution tests; full env reload behavior to be covered by manual smoke test when setting `RATE_LIMIT_DISABLED=1` at startup.
- **3.3.1 Integration test** skipped (no harness for provider mocks / `Bun.serve` in scope). Documented here per tasks.md guidance; rely on unit tests + manual smoke.

### Test harness choice

- Selected `bun:test` (built-in, zero new deps). Added `"test": "bun test"` to `package.json`.

### Test inventory (by group)

- Bucket math: 8
- Config resolution: 4
- Disabled flag behavior: 2
- Atomicity: 1
- Streaming semantics: 1
- Headers helper: 1

### Test runs

- `bun test services/rate-limiter.test.ts` — PASS (17 tests).
- `bun run typecheck` — PASS.

### Files modified

| File | Lines | Change |
|------|-------|--------|
| `services/rate-limiter.test.ts` | 1–235 | New unit tests for rate limiter (17 tests) |
| `package.json` | scripts | Added `test` script for bun:test |
| `openspec/changes/rate-limit-per-token/tasks.md` | Phase 3 section | Marked 3.1.1 and 3.2.1–3.2.5 complete; noted 3.3.1 skipped |

### Notes for next batch (Batch H — README docs)

1. README test-harness note from 3.1.1 is still pending (skipped here per scope restriction).
2. Consider documenting the kill-switch manual test steps alongside rate limit docs.

---

## Run 7 — Phase 4 (Batch H)

**Date:** 2026-04-28
**Mode:** openspec
**Scope applied:** Batch H per tasks.md — README docs for rate limiting, observability, and operator runbook.

### Leaves checked off

- [x] 4.1.1 — Documented env defaults (`RATE_LIMIT_PER_MINUTE_DEFAULT`, `RATE_LIMIT_BURST_DEFAULT`, `RATE_LIMIT_DISABLED=1`), per-token overrides, `X-RateLimit-*` headers (delta-seconds), 429 body shape, and `Retry-After` semantics in README.
- [x] 4.1.2 — Documented caveats: in-memory buckets reset on restart; multi-instance not safe (limit scales with instance count).
- [x] 4.2.1 — Added `gateway_ratelimit_total{token_label, outcome}` to metrics list with cardinality note (keep ≤50 token labels per deployment).
- [x] 4.3.1 — Linked `RATE_LIMITED` error code row to the new Rate Limiting section.
- [x] 4.4.1 — Added operator runbook curl example for per-token override via `PATCH /admin/tokens/:id`.
- [x] 4.4.2 — Documented kill switch (`RATE_LIMIT_DISABLED=1`, requires restart) and manual smoke steps.
- [x] 3.3.2 — Documented integration-test skip and manual smoke guidance in README testing notes.

### Files modified

| File | Lines | Change |
|------|-------|--------|
| `README.md` | Rate Limiting + Metrics + Env vars sections | Added rate limit docs, testing notes, operator example, and metrics entry |
| `openspec/changes/rate-limit-per-token/tasks.md` | Phase 3/4 section | Marked docs complete and recorded integration-test skip documentation |

### Notes

- Integration test 3.3.1 remains skipped; README now calls out the gap and provides manual smoke steps.
