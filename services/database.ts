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
        origin_ip TEXT
      )
    `);

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
}): void {
  if (!db) return;
  db.execute({
    sql: `INSERT INTO usage_logs (model, provider, tokens_input, tokens_output, duration_ms, success, error_message, error_code, origin_ip)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  }).catch(err => console.error('[Database] Failed to log usage:', err));
}

import type { ProviderType } from '../types';

let modelConfigCache = new Map<string, ProviderType>();

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
