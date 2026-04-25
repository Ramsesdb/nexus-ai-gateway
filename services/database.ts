/**
 * Nexus AI Gateway - Turso/LibSQL Database Service
 * Handles connection lifecycle, table creation, usage logging, and dashboard queries.
 */

import { createClient, type Client } from '@libsql/client';

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
}): void {
  if (!db) return;
  db.execute({
    sql: `INSERT INTO usage_logs (model, provider, tokens_input, tokens_output, duration_ms, success, error_message, error_code, origin_ip, referer, user_agent, request_preview, response_preview)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
