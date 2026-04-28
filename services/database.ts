/**
 * Nexus AI Gateway - Turso/LibSQL Database Service
 * Handles connection lifecycle, table creation, usage logging, and dashboard queries.
 */

import { createClient, type Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import type { GatewayToken } from '../types';

let db: Client | null = null;

export function getDb(): Client | null {
  return db;
}

export async function initDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  const authToken = process.env.DATABASE_AUTH_TOKEN?.trim();

  if (!url) {
    console.warn('[Database] DATABASE_URL not set. Dashboard features will be unavailable.');
    return;
  }

  try {
    db = createClient({ url, authToken: authToken || undefined });

    await db.execute(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        error_code TEXT,
        origin_ip TEXT,
        referer TEXT,
        user_agent TEXT,
        request_preview TEXT,
        response_preview TEXT
      )
    `);

    try { await db.execute(`ALTER TABLE usage_logs ADD COLUMN request_preview TEXT`); } catch { /* column may already exist */ }
    try { await db.execute(`ALTER TABLE usage_logs ADD COLUMN response_preview TEXT`); } catch { /* column may already exist */ }
    try { await db.execute(`ALTER TABLE usage_logs ADD COLUMN referer TEXT`); } catch { /* column may already exist */ }
    try { await db.execute(`ALTER TABLE usage_logs ADD COLUMN user_agent TEXT`); } catch { /* column may already exist */ }
    // Per-user token attribution: NULL means master-key (admin) request.
    try { await db.execute(`ALTER TABLE usage_logs ADD COLUMN token_id INTEGER`); } catch { /* column may already exist */ }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        key_value TEXT NOT NULL,
        account_id TEXT,
        label TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS model_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Per-user gateway tokens. The master key remains the admin credential;
    // these tokens are individual, label-scoped credentials with optional
    // monthly token quotas, intended to be handed out to friends/teammates.
    await db.execute(`
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
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_gateway_tokens_secret ON gateway_tokens(secret)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_gateway_tokens_active ON gateway_tokens(active)`);

    // Per-token rate-limit overrides. NULL → resolve to env defaults at runtime.
    try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_per_minute INTEGER`); } catch { /* column may already exist */ }
    try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_burst INTEGER`); } catch { /* column may already exist */ }
    try { await db.execute(`ALTER TABLE gateway_tokens ADD COLUMN rate_limit_disabled INTEGER NOT NULL DEFAULT 0`); } catch { /* column may already exist */ }

    console.log('[Database] Connected and tables initialized.');
  } catch (err) {
    console.error('[Database] Connection failed:', err);
    db = null;
  }
}

export function logUsage(params: {
  model: string;
  provider: string;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number;
  success: number;
  errorMessage?: string;
  errorCode?: string;
  originIp?: string;
  referer?: string;
  userAgent?: string;
  requestPreview?: string;
  responsePreview?: string;
  tokenId?: number | null;
}): void {
  if (!db) return;
  db.execute({
    sql: `INSERT INTO usage_logs (model, provider, tokens_input, tokens_output, duration_ms, success, error_message, error_code, origin_ip, referer, user_agent, request_preview, response_preview, token_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      params.model,
      params.provider,
      params.tokensInput,
      params.tokensOutput,
      params.durationMs,
      params.success,
      params.errorMessage || null,
      params.errorCode || null,
      params.originIp || null,
      params.referer || null,
      params.userAgent || null,
      params.requestPreview || null,
      params.responsePreview || null,
      params.tokenId ?? null,
    ],
  }).catch(err => console.error('[Database] Failed to log usage:', err));
}

import type { ProviderType, TrackedService } from '../types';

let modelConfigCache = new Map<string, ProviderType>();

const PROVIDER_MODEL_MAP: Record<ProviderType, { envVar: string; defaultModel: string }> = {
  groq: { envVar: 'GROQ_MODEL', defaultModel: 'llama-4-scout-17b-16e-instruct' },
  gemini: { envVar: 'GEMINI_MODEL', defaultModel: 'gemini-2.5-flash' },
  openrouter: { envVar: 'OPENROUTER_MODEL', defaultModel: 'deepseek/deepseek-r1-0528:free' },
  cerebras: { envVar: 'CEREBRAS_MODEL', defaultModel: 'zai-glm-4.7' },
  cloudflare: { envVar: 'CLOUDFLARE_MODEL', defaultModel: '@cf/meta/llama-3.1-8b-instruct' },
};

export interface SeedKeyConfig {
  provider: ProviderType;
  apiKey: string;
  instanceId: string;
}

export function seedModels(pool: TrackedService[]): void {
  if (!db) return;
  try {
    const seen = new Set<ProviderType>();
    for (const tracked of pool) {
      const provider: ProviderType = tracked.service.provider;
      if (seen.has(provider)) continue;
      seen.add(provider);
      const map = PROVIDER_MODEL_MAP[provider];
      if (!map) continue;
      const modelName = process.env[map.envVar]?.trim() || map.defaultModel;
      db.execute({
        sql: 'INSERT OR IGNORE INTO model_config (model_name, provider) VALUES (?, ?)',
        args: [modelName, provider],
      }).catch(err => console.error(`[Database] seedModels failed for ${provider}:`, err));
    }
    // Note: 'auto' is a pseudo-model handled by the router (services/router.ts).
    // It must NOT live in model_config — getCachedModelProvider('auto') would
    // override the router's universal-fallback route with the bogus provider
    // string 'auto', which matches no tracked service and yields a 400.
    // Clean up any stale row from earlier builds that did seed it.
    db.execute({
      sql: "DELETE FROM model_config WHERE model_name = 'auto'",
      args: [],
    }).catch(err => console.error('[Database] seedModels cleanup of stale auto row failed:', err));
  } catch (err) {
    console.error('[Database] seedModels error:', err);
  }
}

export function seedApiKeys(keys: SeedKeyConfig[]): void {
  if (!db) return;
  try {
    const displayNames: Record<ProviderType, string> = {
      groq: 'Groq',
      gemini: 'Gemini',
      openrouter: 'OpenRouter',
      cerebras: 'Cerebras',
      cloudflare: 'Cloudflare',
    };
    for (const key of keys) {
      const label = `${displayNames[key.provider]} #${key.instanceId}`;
      db.execute({
        sql: `INSERT INTO api_keys (provider, key_value, label)
              SELECT ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM api_keys WHERE provider = ? AND label = ?)`,
        args: [key.provider, key.apiKey, label, key.provider, label],
      }).catch(err => console.error(`[Database] seedApiKeys failed for ${label}:`, err));
    }
  } catch (err) {
    console.error('[Database] seedApiKeys error:', err);
  }
}

export async function refreshModelConfigCache(): Promise<void> {
  if (!db) return;
  try {
    const result = await db.execute(
      'SELECT model_name, provider FROM model_config WHERE active = 1'
    );
    modelConfigCache.clear();
    for (const row of result.rows) {
      modelConfigCache.set(
        row.model_name as string,
        row.provider as ProviderType
      );
    }
  } catch (err) {
    console.error('[Database] Failed to refresh model config cache:', err);
  }
}

export function getCachedModelProvider(modelName: string): ProviderType | undefined {
  return modelConfigCache.get(modelName);
}

export function maskKey(value: string): string {
  if (value.length <= 8) return value;
  return value.slice(0, 4) + '...' + value.slice(-4);
}

// =============================================================================
// GATEWAY TOKENS (per-user credentials with optional monthly token quotas)
// =============================================================================

/**
 * Compute the next quota reset timestamp: first day of next month at 00:00 UTC,
 * formatted as ISO-8601 ("YYYY-MM-DDTHH:mm:ss.sssZ").
 */
function nextMonthlyResetIso(from: Date = new Date()): string {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth(); // 0-11
  // First day of next month at 00:00:00 UTC.
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
}

/**
 * Map a raw row from `gateway_tokens` into the typed `GatewayToken` shape.
 * Numeric flags come back as bigint/number from libsql; coerce them.
 */
function rowToGatewayToken(r: any): GatewayToken {
  return {
    id: Number(r.id),
    label: String(r.label),
    secret: String(r.secret),
    active: Number(r.active) === 1 ? 1 : 0,
    monthly_quota_tokens: r.monthly_quota_tokens == null ? null : Number(r.monthly_quota_tokens),
    used_tokens_current_month: Number(r.used_tokens_current_month ?? 0),
    quota_reset_at: r.quota_reset_at == null ? null : String(r.quota_reset_at),
    created_at: String(r.created_at),
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    notes: r.notes == null ? null : String(r.notes),
    rate_limit_per_minute: r.rate_limit_per_minute == null ? null : Number(r.rate_limit_per_minute),
    rate_limit_burst: r.rate_limit_burst == null ? null : Number(r.rate_limit_burst),
    rate_limit_disabled: Number(r.rate_limit_disabled ?? 0) === 1 ? 1 : 0,
  };
}

/**
 * Lookup a gateway token by its full secret value. Returns `null` if the DB
 * is unavailable, the secret is not found, or any error occurs.
 */
export async function findGatewayTokenBySecret(secret: string): Promise<GatewayToken | null> {
  if (!db) return null;
  try {
    const result = await db.execute({
      sql: 'SELECT id, label, secret, active, monthly_quota_tokens, used_tokens_current_month, quota_reset_at, created_at, last_used_at, notes, rate_limit_per_minute, rate_limit_burst, rate_limit_disabled FROM gateway_tokens WHERE secret = ? LIMIT 1',
      args: [secret],
    });
    if (result.rows.length === 0) return null;
    return rowToGatewayToken(result.rows[0]);
  } catch (err) {
    console.error('[Database] findGatewayTokenBySecret failed:', err);
    return null;
  }
}

/**
 * Increment a token's monthly usage counter. If the stored `quota_reset_at`
 * has already passed, the counter is reset to the new amount (not added) and
 * `quota_reset_at` is rolled forward to the first of the next month.
 */
export async function incrementTokenUsage(tokenId: number, tokensUsed: number): Promise<void> {
  if (!db) return;
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) {
    // Still bump last_used_at on zero-token requests so dashboards show activity.
    try {
      await db.execute({
        sql: `UPDATE gateway_tokens SET last_used_at = datetime('now') WHERE id = ?`,
        args: [tokenId],
      });
    } catch (err) {
      console.error('[Database] incrementTokenUsage (last_used_at only) failed:', err);
    }
    return;
  }
  try {
    const row = await db.execute({
      sql: 'SELECT quota_reset_at, used_tokens_current_month FROM gateway_tokens WHERE id = ? LIMIT 1',
      args: [tokenId],
    });
    if (row.rows.length === 0) return;
    const r: any = row.rows[0];
    const resetAt: string | null = r.quota_reset_at == null ? null : String(r.quota_reset_at);
    const now = new Date();
    const needsReset = !resetAt || new Date(resetAt).getTime() <= now.getTime();

    if (needsReset) {
      const nextReset = nextMonthlyResetIso(now);
      await db.execute({
        sql: `UPDATE gateway_tokens
              SET used_tokens_current_month = ?,
                  quota_reset_at = ?,
                  last_used_at = datetime('now')
              WHERE id = ?`,
        args: [Math.floor(tokensUsed), nextReset, tokenId],
      });
    } else {
      await db.execute({
        sql: `UPDATE gateway_tokens
              SET used_tokens_current_month = used_tokens_current_month + ?,
                  last_used_at = datetime('now')
              WHERE id = ?`,
        args: [Math.floor(tokensUsed), tokenId],
      });
    }
  } catch (err) {
    console.error('[Database] incrementTokenUsage failed:', err);
  }
}

/**
 * Generate a fresh secret of the form "tk_<48 hex chars>".
 */
function generateTokenSecret(): string {
  return 'tk_' + randomBytes(24).toString('hex');
}

/**
 * Create a new gateway token. Returns the freshly generated id + secret.
 * Throws if the DB is unavailable.
 *
 * The optional `rateLimit` block lets the caller persist per-token overrides:
 * `perMinute` / `burst` may be a non-negative integer, `null`, or omitted
 * (NULL → resolve to env default at runtime). `disabled` defaults to `false`.
 */
export async function createGatewayToken(
  label: string,
  monthlyQuotaTokens?: number | null,
  notes?: string | null,
  rateLimit?: {
    perMinute?: number | null;
    burst?: number | null;
    disabled?: boolean;
  },
): Promise<{ id: number; secret: string; quotaResetAt: string }> {
  if (!db) throw new Error('Database unavailable');
  const trimmedLabel = label.trim();
  if (!trimmedLabel) throw new Error('label is required');

  const secret = generateTokenSecret();
  const quotaResetAt = nextMonthlyResetIso();
  const quota = monthlyQuotaTokens == null ? null : Math.max(0, Math.floor(monthlyQuotaTokens));

  const ratePerMinute = rateLimit?.perMinute == null ? null : Math.max(0, Math.floor(rateLimit.perMinute));
  const rateBurst = rateLimit?.burst == null ? null : Math.max(0, Math.floor(rateLimit.burst));
  const rateDisabled = rateLimit?.disabled === true ? 1 : 0;

  const result = await db.execute({
    sql: `INSERT INTO gateway_tokens (label, secret, active, monthly_quota_tokens, used_tokens_current_month, quota_reset_at, notes, rate_limit_per_minute, rate_limit_burst, rate_limit_disabled)
          VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    args: [trimmedLabel, secret, quota, quotaResetAt, notes?.trim() || null, ratePerMinute, rateBurst, rateDisabled],
  });

  const id = Number(result.lastInsertRowid ?? 0);
  return { id, secret, quotaResetAt };
}

/**
 * Mask a secret for display: show prefix + last 4. Returns "tk_a1b2***...***xyz9".
 */
export function maskTokenSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 12) return secret.slice(0, 4) + '***';
  return secret.slice(0, 6) + '***' + secret.slice(-4);
}

/**
 * List all gateway tokens with masked secrets.
 */
export async function listGatewayTokens(): Promise<Array<Omit<GatewayToken, 'secret'> & { secret_masked: string }>> {
  if (!db) return [];
  try {
    const result = await db.execute(
      'SELECT id, label, secret, active, monthly_quota_tokens, used_tokens_current_month, quota_reset_at, created_at, last_used_at, notes, rate_limit_per_minute, rate_limit_burst, rate_limit_disabled FROM gateway_tokens ORDER BY id DESC'
    );
    return result.rows.map((r: any) => {
      const tok = rowToGatewayToken(r);
      const { secret, ...rest } = tok;
      return { ...rest, secret_masked: maskTokenSecret(secret) };
    });
  } catch (err) {
    console.error('[Database] listGatewayTokens failed:', err);
    return [];
  }
}

/**
 * Soft-revoke a token (sets active=0). Returns the row's label, or null if not found.
 */
export async function revokeGatewayToken(id: number): Promise<{ label: string } | null> {
  if (!db) throw new Error('Database unavailable');
  const before = await db.execute({
    sql: 'SELECT label FROM gateway_tokens WHERE id = ? LIMIT 1',
    args: [id],
  });
  if (before.rows.length === 0) return null;
  await db.execute({
    sql: 'UPDATE gateway_tokens SET active = 0 WHERE id = ?',
    args: [id],
  });
  return { label: String((before.rows[0] as any).label) };
}

/**
 * Partial update of a gateway token. Only provided fields are touched.
 * `monthlyQuotaTokens` may be passed as `null` to explicitly clear the quota.
 *
 * Rate-limit fields use tri-state semantics:
 *   undefined → leave column as-is (no SET clause emitted)
 *   null      → SET column = NULL (clear override; runtime resolves to env default)
 *   number    → SET column = value
 * `rateLimitDisabled: boolean` toggles the flag (true → 1, false → 0).
 */
export async function updateGatewayToken(
  id: number,
  changes: {
    active?: boolean;
    monthlyQuotaTokens?: number | null;
    notes?: string | null;
    ratePerMinute?: number | null;
    rateBurst?: number | null;
    rateLimitDisabled?: boolean;
  },
): Promise<boolean> {
  if (!db) throw new Error('Database unavailable');
  const sets: string[] = [];
  const args: Array<string | number | null> = [];

  if (changes.active !== undefined) {
    sets.push('active = ?');
    args.push(changes.active ? 1 : 0);
  }
  if (changes.monthlyQuotaTokens !== undefined) {
    sets.push('monthly_quota_tokens = ?');
    args.push(changes.monthlyQuotaTokens == null ? null : Math.max(0, Math.floor(changes.monthlyQuotaTokens)));
  }
  if (changes.notes !== undefined) {
    sets.push('notes = ?');
    args.push(changes.notes == null ? null : (changes.notes.trim() || null));
  }
  if (changes.ratePerMinute !== undefined) {
    sets.push('rate_limit_per_minute = ?');
    args.push(changes.ratePerMinute == null ? null : Math.max(0, Math.floor(changes.ratePerMinute)));
  }
  if (changes.rateBurst !== undefined) {
    sets.push('rate_limit_burst = ?');
    args.push(changes.rateBurst == null ? null : Math.max(0, Math.floor(changes.rateBurst)));
  }
  if (changes.rateLimitDisabled !== undefined) {
    sets.push('rate_limit_disabled = ?');
    args.push(changes.rateLimitDisabled ? 1 : 0);
  }

  if (sets.length === 0) return false;

  args.push(id);
  const result = await db.execute({
    sql: `UPDATE gateway_tokens SET ${sets.join(', ')} WHERE id = ?`,
    args,
  });
  return Number((result as any).rowsAffected ?? 0) > 0;
}

/**
 * Reset a token's monthly counter to zero and roll `quota_reset_at` forward.
 * Returns false when the token does not exist.
 */
export async function resetGatewayTokenUsage(id: number): Promise<boolean> {
  if (!db) throw new Error('Database unavailable');
  const exists = await db.execute({
    sql: 'SELECT id FROM gateway_tokens WHERE id = ? LIMIT 1',
    args: [id],
  });
  if (exists.rows.length === 0) return false;

  await db.execute({
    sql: `UPDATE gateway_tokens
          SET used_tokens_current_month = 0,
              quota_reset_at = ?
          WHERE id = ?`,
    args: [nextMonthlyResetIso(), id],
  });
  return true;
}
