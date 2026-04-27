/**
 * Nexus AI Gateway v1.0 - Production-Ready AI Proxy
 * Features: Health-aware load balancing, Circuit Breaker, Graceful Shutdown
 */

import { createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
import { GroqService } from './services/groq';
import { GeminiService } from './services/gemini';
import { OpenRouterService } from './services/openrouter';
import { CerebrasService } from './services/cerebras';
import { CloudflareService } from './services/cloudflare';
import { resolveRoute, type ResolvedRoute } from './services/router';
import {
  initDatabase,
  getDb,
  logUsage,
  refreshModelConfigCache,
  getCachedModelProvider,
  maskKey,
  seedModels,
  seedApiKeys,
  findGatewayTokenBySecret,
  incrementTokenUsage,
  createGatewayToken,
  listGatewayTokens,
  revokeGatewayToken,
  updateGatewayToken,
  resetGatewayTokenUsage,
  type SeedKeyConfig,
} from './services/database';
import type {
  AIService,
  AuthContext,
  ChatMessage,
  ChatStreamChunk,
  ProviderType,
  ServiceMetrics,
  ToolCallDelta,
  TrackedService,
} from './types';

// --- 1. CONFIGURATION ---
const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  firstTokenTimeoutMs: Number(process.env.FIRST_TOKEN_TIMEOUT_MS) || 8000,

  // Security: Master API Key (optional, but highly recommended for production)
  masterKey: process.env.NEXUS_MASTER_KEY || '',

  // Security: Dashboard login (email + password). The HMAC secret signs the
  // session cookie; the password hash is verified with Bun.password (bcrypt)
  // or, when the hash is prefixed with `scrypt$`, with node:crypto scrypt.
  // If any of the three is missing, dashboard auth is DISABLED and the
  // dashboard remains publicly accessible (legacy behavior, with a warning).
  dashboardEmail: (process.env.DASHBOARD_EMAIL || '').trim().toLowerCase(),
  dashboardPasswordHash: process.env.DASHBOARD_PASSWORD_HASH || '',
  dashboardSessionSecret: process.env.DASHBOARD_SESSION_SECRET || '',
  dashboardSessionMaxAgeSec: 60 * 60 * 24 * 7, // 7 days

  // Security: CORS whitelist (comma-separated origins, or '*' for all)
  corsAllowedOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),

  // Health scoring
  errorPenaltyDurationMs: 30_000,
  minRequestsForScoring: 3,

  // Circuit Breaker
  circuitBreaker: {
    failureThreshold: 3,        // Failures before opening circuit
    resetTimeoutMs: 60_000,     // Time before attempting to close circuit (1 min)
    halfOpenMaxAttempts: 1,     // Requests allowed in half-open state
  },

  // Exponential Backoff
  backoff: {
    initialDelayMs: 100,        // Initial delay between retries
    maxDelayMs: 2000,           // Maximum delay
    multiplier: 2,              // Multiply delay by this each retry
  },

  // Graceful Shutdown
  shutdownTimeoutMs: 10_000,    // Max time to wait for in-flight requests
} as const;

// --- 2. CIRCUIT BREAKER STATE ---
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailureTime?: number;
  halfOpenAttempts: number;
}

// --- 3. ENHANCED SERVICE TRACKING ---
interface EnhancedTrackedService extends TrackedService {
  circuitBreaker: CircuitBreakerState;
}

const trackedServices: EnhancedTrackedService[] = [];
let roundRobinPointer = 0;

// In-flight request counter for graceful shutdown
let inFlightRequests = 0;
let isShuttingDown = false;

// --- 4. SERVICE POOL INITIALIZATION ---
interface ProviderKeyConfig {
  provider: ProviderType;
  instanceId: string;
  apiKey: string;
  priority: number;
  /**
   * Provider-specific extra configuration. Currently used to carry the Cloudflare
   * account ID that is paired with each CLOUDFLARE_KEY_N via CLOUDFLARE_ACCOUNT_ID_N.
   */
  accountId?: string;
}

const collectProviderKeys = (): ProviderKeyConfig[] => {
  // Provider priority for load balancing (higher = preferred)
  // Strategy: Cerebras (fastest) > Groq (reliable) > Cloudflare (edge) > OpenRouter (free) > Gemini (avoid abuse blocks)
  const providerPriorityOrder: Record<ProviderType, number> = {
    cerebras: 10,   // Best free tier: 1M tokens/day, 2000+ tok/s
    groq: 8,        // Reliable backup: 500+ tok/s
    cloudflare: 7,  // Workers AI: ~400ms latency, 10K neurons/day
    openrouter: 6,  // Free tier backup
    gemini: 2,      // LAST RESORT - can block for abuse from same IP
  };

  const patterns = [
    { provider: 'groq' as ProviderType, prefix: 'GROQ_KEY_', priority: 2 },
    { provider: 'gemini' as ProviderType, prefix: 'GEMINI_KEY_', priority: 2 },
    { provider: 'openrouter' as ProviderType, prefix: 'OPENROUTER_KEY_', priority: 2 },
    { provider: 'cerebras' as ProviderType, prefix: 'CEREBRAS_KEY_', priority: 2 },
    { provider: 'cloudflare' as ProviderType, prefix: 'CLOUDFLARE_KEY_', priority: 2 },
    { provider: 'groq' as ProviderType, prefix: 'GROQ_API_KEY_', priority: 1 },
    { provider: 'gemini' as ProviderType, prefix: 'GEMINI_API_KEY_', priority: 1 },
    { provider: 'openrouter' as ProviderType, prefix: 'OPENROUTER_API_KEY_', priority: 1 },
    { provider: 'cerebras' as ProviderType, prefix: 'CEREBRAS_API_KEY_', priority: 1 },
    { provider: 'cloudflare' as ProviderType, prefix: 'CLOUDFLARE_API_KEY_', priority: 1 },
  ];

  const chosen = new Map<string, ProviderKeyConfig>();

  for (const [envVar, value] of Object.entries(process.env)) {
    if (!value) continue;

    for (const pattern of patterns) {
      if (!envVar.startsWith(pattern.prefix)) continue;

      const instanceId = envVar.slice(pattern.prefix.length);
      if (!/^\d+$/.test(instanceId)) continue;

      const key = `${pattern.provider}:${instanceId}`;
      const candidate: ProviderKeyConfig = {
        provider: pattern.provider,
        instanceId,
        apiKey: value,
        priority: pattern.priority,
      };

      const existing = chosen.get(key);
      if (!existing || candidate.priority > existing.priority) {
        chosen.set(key, candidate);
      }
    }
  }

  // Cloudflare account-ID pairing.
  // Each CLOUDFLARE_KEY_N must be paired with CLOUDFLARE_ACCOUNT_ID_N (own account ID).
  // If only the legacy shared CLOUDFLARE_ACCOUNT_ID is set, use it as a fallback so the
  // previously-deployed single-account setup keeps working without reconfiguration.
  // Keys with no resolvable account ID are skipped with a warning.
  const sharedCloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';

  for (const [key, config] of [...chosen.entries()]) {
    if (config.provider !== 'cloudflare') continue;

    const perKeyAccountId = process.env[`CLOUDFLARE_ACCOUNT_ID_${config.instanceId}`]?.trim() || '';
    const resolvedAccountId = perKeyAccountId || sharedCloudflareAccountId;

    if (!resolvedAccountId) {
      console.warn(
        `⚠️  Cloudflare key #${config.instanceId} has no matching ` +
        `CLOUDFLARE_ACCOUNT_ID_${config.instanceId} (and no shared CLOUDFLARE_ACCOUNT_ID fallback) — skipping.`
      );
      chosen.delete(key);
      continue;
    }

    config.accountId = resolvedAccountId;
  }

  // Sort by: 1) Provider priority (descending), 2) Instance ID (ascending)
  return [...chosen.values()].sort((a, b) => {
    const priorityA = providerPriorityOrder[a.provider] || 0;
    const priorityB = providerPriorityOrder[b.provider] || 0;
    if (priorityA !== priorityB) return priorityB - priorityA; // Higher priority first
    return Number(a.instanceId) - Number(b.instanceId);
  });
};

const createService = (config: ProviderKeyConfig): AIService => {
  switch (config.provider) {
    case 'groq':
      return new GroqService(config.apiKey, config.instanceId);
    case 'gemini':
      return new GeminiService(config.apiKey, config.instanceId);
    case 'openrouter':
      return new OpenRouterService(config.apiKey, config.instanceId);
    case 'cerebras':
      return new CerebrasService(config.apiKey, config.instanceId);
    case 'cloudflare':
      if (!config.accountId) {
        throw new Error(
          `Cloudflare key #${config.instanceId} is missing a paired account ID ` +
          `(CLOUDFLARE_ACCOUNT_ID_${config.instanceId} or shared CLOUDFLARE_ACCOUNT_ID).`
        );
      }
      return new CloudflareService(config.apiKey, config.accountId, config.instanceId);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
};

const createInitialMetrics = (): ServiceMetrics => ({
  totalRequests: 0,
  successCount: 0,
  failCount: 0,
  skipCount: 0,
  totalLatencyMs: 0,
});

const createInitialCircuitBreaker = (): CircuitBreakerState => ({
  state: 'CLOSED',
  failures: 0,
  halfOpenAttempts: 0,
});

const providerKeyConfigs = collectProviderKeys();

// Initialize services
for (const config of providerKeyConfigs) {
  try {
    const service = createService(config);
    trackedServices.push({
      service,
      metrics: createInitialMetrics(),
      circuitBreaker: createInitialCircuitBreaker(),
      enabled: true, // Initialize enabled to true
    });
  } catch (error) {
    console.warn(`Failed to initialize ${config.provider} #${config.instanceId}:`, error);
  }
}

if (trackedServices.length === 0) {
  console.error('🚨 CRITICAL: No API keys found in .env file. Server cannot start.');
  process.exit(1);
}

// --- 5. CIRCUIT BREAKER LOGIC ---

/**
 * Check if a service is available based on circuit breaker state
 */
const isServiceAvailable = (tracked: EnhancedTrackedService): boolean => {
  const { circuitBreaker: cb } = tracked;
  const now = Date.now();

  switch (cb.state) {
    case 'CLOSED':
      return true;

    case 'OPEN':
      // Check if reset timeout has passed
      if (cb.lastFailureTime && (now - cb.lastFailureTime) >= CONFIG.circuitBreaker.resetTimeoutMs) {
        // Transition to half-open
        cb.state = 'HALF_OPEN';
        cb.halfOpenAttempts = 0;
        console.log(`[CircuitBreaker] ${tracked.service.name}: OPEN -> HALF_OPEN`);
        return true;
      }
      return false;

    case 'HALF_OPEN':
      // Allow limited attempts in half-open state
      return cb.halfOpenAttempts < CONFIG.circuitBreaker.halfOpenMaxAttempts;

    default:
      return true;
  }
};

/**
 * Record a successful request - may close the circuit
 */
const recordSuccess = (tracked: EnhancedTrackedService): void => {
  const { circuitBreaker: cb } = tracked;

  if (cb.state === 'HALF_OPEN') {
    // Success in half-open state closes the circuit
    cb.state = 'CLOSED';
    cb.failures = 0;
    cb.halfOpenAttempts = 0;
    console.log(`[CircuitBreaker] ${tracked.service.name}: HALF_OPEN -> CLOSED (recovered)`);
  } else if (cb.state === 'CLOSED') {
    // Reset failure count on success
    cb.failures = Math.max(0, cb.failures - 1);
  }
};

/**
 * Record a failed request - may open the circuit
 */
const recordFailure = (tracked: EnhancedTrackedService): void => {
  const { circuitBreaker: cb } = tracked;
  cb.lastFailureTime = Date.now();

  if (cb.state === 'HALF_OPEN') {
    // Failure in half-open state reopens the circuit
    cb.state = 'OPEN';
    cb.halfOpenAttempts = 0;
    console.log(`[CircuitBreaker] ${tracked.service.name}: HALF_OPEN -> OPEN (still failing)`);
  } else if (cb.state === 'CLOSED') {
    cb.failures++;
    if (cb.failures >= CONFIG.circuitBreaker.failureThreshold) {
      cb.state = 'OPEN';
      console.log(`[CircuitBreaker] ${tracked.service.name}: CLOSED -> OPEN (threshold reached: ${cb.failures} failures)`);
    }
  }
};

// --- 6. EXPONENTIAL BACKOFF ---

/**
 * Calculate delay for retry attempt using exponential backoff
 */
const calculateBackoffDelay = (attempt: number): number => {
  const delay = CONFIG.backoff.initialDelayMs * Math.pow(CONFIG.backoff.multiplier, attempt - 1);
  return Math.min(delay, CONFIG.backoff.maxDelayMs);
};

/**
 * Sleep for specified milliseconds
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Best-effort HTTP status extraction for upstream errors.
 * Covers the OpenAI SDK (`err.status`), fetch Response errors (`err.response.status`),
 * and string fallbacks like "404 The model ... does not exist".
 */
const extractHttpStatus = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  const msg = (e.message as string | undefined) || '';
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  return match?.[1] ? Number(match[1]) : undefined;
};

/**
 * Best-effort extraction of an upstream error body for debug logging.
 * Handles OpenAI SDK shapes (`err.error`, `err.response.data`) and plain strings.
 * TEMP DEBUG: used to trace 400 "Invalid messages format" from providers.
 */
const extractErrorBody = (err: unknown): string => {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const candidates: unknown[] = [
    e.error,
    (e.response as Record<string, unknown> | undefined)?.data,
    (e.response as Record<string, unknown> | undefined)?.body,
    e.body,
    e.message,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'string' && c.length > 0) return c;
    try {
      const s = JSON.stringify(c);
      if (s && s !== '{}') return s;
    } catch { /* ignore */ }
  }
  try { return JSON.stringify(e); } catch { return String(err); }
};

/**
 * Extract Retry-After header (seconds) from an upstream error when available.
 */
const extractRetryAfter = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const headers =
    (e.headers as Record<string, string> | undefined)
    ?? ((e.response as Record<string, unknown> | undefined)?.headers as Record<string, string> | undefined);
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const extractRequestPreview = (messages: unknown): string => {
  try {
    const arr = messages as any[];
    if (!Array.isArray(arr)) return '';
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m?.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content.slice(0, 200);
      if (Array.isArray(m.content)) {
        const textPart = m.content.find((p: any) => p?.type === 'text');
        if (textPart && typeof textPart.text === 'string') return textPart.text.slice(0, 200);
      }
      return '';
    }
  } catch { /* ignore */ }
  return '';
};

/**
 * Build a preview string for the model's response so it can be saved to
 * `usage_logs.response_preview` and shown in the dashboard.
 *
 * Priority:
 *   1. If `message.content` is a non-empty string, return it (capped).
 *   2. Else, if `message.tool_calls` is a non-empty array, render a
 *      `[tool_calls] name1({...args1...}) | name2({...args2...})` summary
 *      so the gateway operator can see which tool the model wanted to invoke
 *      and with what arguments (essential for debugging tool-use flows).
 *   3. Else, return the literal `(empty response)` so the dashboard shows
 *      something distinguishable from `null`.
 *
 * Cap matches the existing 300-char limit used at the call sites.
 */
const extractResponsePreview = (
  message: unknown,
  accumulatedContent?: string,
  accumulatedToolCalls?: Array<{ name?: string; arguments?: string }>
): string => {
  const CAP = 300;
  try {
    const m = message as any;
    const content = typeof m?.content === 'string' ? m.content : '';
    if (content) return content.slice(0, CAP);

    if (accumulatedContent) return accumulatedContent.slice(0, CAP);

    const toolCalls = m?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const parts: string[] = [];
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? tc?.name ?? 'unknown';
        const rawArgs = tc?.function?.arguments;
        const args = typeof rawArgs === 'string'
          ? rawArgs
          : (rawArgs !== undefined ? JSON.stringify(rawArgs) : '');
        parts.push(`${name}(${args})`);
      }
      return `[tool_calls] ${parts.join(' | ')}`.slice(0, CAP);
    }

    // Stream-path fallback: tool_calls were accumulated from delta chunks.
    if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
      const parts = accumulatedToolCalls.map(tc =>
        `${tc.name ?? 'unknown'}(${tc.arguments ?? ''})`
      );
      return `[tool_calls] ${parts.join(' | ')}`.slice(0, CAP);
    }
  } catch { /* ignore */ }

  if (accumulatedContent) return accumulatedContent.slice(0, CAP);
  if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
    const parts = accumulatedToolCalls.map(tc =>
      `${tc.name ?? 'unknown'}(${tc.arguments ?? ''})`
    );
    return `[tool_calls] ${parts.join(' | ')}`.slice(0, CAP);
  }
  return '(empty response)';
};

// --- 7. HEALTH-AWARE LOAD BALANCER ---

const calculateHealthScore = (tracked: EnhancedTrackedService): number => {
  const { metrics, circuitBreaker: cb, service } = tracked;

  // Circuit breaker penalty
  if (cb.state === 'OPEN') return 0;
  if (cb.state === 'HALF_OPEN') return 0.1;

  // Provider priority bonus (ensures preferred providers are selected when scores are similar)
  const priorityBonus: Record<ProviderType, number> = {
    cerebras: 0.15,    // Highest priority: fastest, best free tier
    groq: 0.10,        // Second priority: reliable
    cloudflare: 0.075, // Third priority: edge inference, ~400ms latency
    openrouter: 0.05,  // Fourth priority: free backup
    gemini: 0.00,      // Last resort: can block for abuse
  };
  const providerName = service.name.toLowerCase();
  const bonus = providerName.includes('cerebras') ? priorityBonus.cerebras :
    providerName.includes('groq') ? priorityBonus.groq :
      providerName.includes('cloudflare') ? priorityBonus.cloudflare :
        providerName.includes('openrouter') ? priorityBonus.openrouter :
          priorityBonus.gemini;

  if (metrics.totalRequests < CONFIG.minRequestsForScoring) {
    return 0.5 + bonus; // Base score + priority bonus
  }

  const successRate = metrics.successCount / metrics.totalRequests;
  const avgLatency = metrics.totalLatencyMs / metrics.totalRequests;
  const latencyScore = Math.max(0, 1 - avgLatency / 5000);

  let recentErrorPenalty = 0;
  if (metrics.lastErrorTime) {
    const timeSinceError = Date.now() - metrics.lastErrorTime;
    if (timeSinceError < CONFIG.errorPenaltyDurationMs) {
      recentErrorPenalty = 0.3 * (1 - timeSinceError / CONFIG.errorPenaltyDurationMs);
    }
  }

  return Math.max(0, Math.min(1, successRate * 0.5 + latencyScore * 0.3 + bonus - recentErrorPenalty));
};

/**
 * Select next available service, respecting circuit breaker state and enabled status.
 * When `allowedProviders` is provided, only services whose provider is in the set
 * are considered. This enforces model-capability routing.
 */
const getNextService = (
  excludeIndices: Set<number>,
  routingMode: 'smart' | 'fastest' | 'round-robin' = 'smart',
  allowedProviders?: ReadonlySet<ProviderType>,
): EnhancedTrackedService | null => {
  const available = trackedServices
    .map((ts, index) => ({ ts, index }))
    .filter(({ ts, index }) => {
      if (excludeIndices.has(index)) return false;
      // Provider is not a candidate for this request — do NOT count as a skip.
      if (allowedProviders && !allowedProviders.has(ts.service.provider)) return false;
      if (!ts.enabled) {
        // Count as a skip for an otherwise-valid candidate (disabled toggle).
        // Add to excludeIndices so retry loops don't re-count the same skip.
        ts.metrics.totalRequests++;
        ts.metrics.skipCount++;
        ts.metrics.lastError = `Provider disabled (enabled=false)`;
        ts.metrics.lastErrorTime = Date.now();
        excludeIndices.add(index);
        return false;
      }
      if (!isServiceAvailable(ts)) {
        // Circuit OPEN / HALF_OPEN-exhausted for a candidate that would have
        // served this request: record the skip so metrics don't freeze.
        // Do NOT bump failCount or consecutiveFailures — skips should not
        // feed the circuit breaker, otherwise open circuits never heal.
        // Add to excludeIndices so retry loops don't re-count the same skip.
        ts.metrics.totalRequests++;
        ts.metrics.skipCount++;
        ts.metrics.lastError = `Circuit breaker state: ${ts.circuitBreaker.state}`;
        ts.metrics.lastErrorTime = Date.now();
        excludeIndices.add(index);
        return false;
      }
      return true;
    });

  if (available.length === 0) return null;
  if (available.length === 1) return available[0]!.ts;

  if (routingMode === 'round-robin') {
    const sorted = available.sort((a, b) => a.index - b.index);
    const choice = sorted[roundRobinPointer % sorted.length]!.ts;
    roundRobinPointer = (roundRobinPointer + 1) % trackedServices.length;
    return choice;
  }

  const scored = available.map(({ ts, index }) => ({
    ts,
    index,
    score: calculateHealthScore(ts),
  }));

  scored.sort((a, b) => b.score - a.score);

  if (routingMode === 'fastest') {
    return scored[0]!.ts;
  }

  const totalScore = scored.reduce((sum, s) => sum + Math.max(0.1, s.score), 0);
  let random = Math.random() * totalScore;

  for (const s of scored) {
    random -= Math.max(0.1, s.score);
    if (random <= 0) return s.ts;
  }

  return scored[0]!.ts;
};

// --- 8. MESSAGE VALIDATION ---

const isValidMessage = (m: unknown): m is ChatMessage => {
  if (!m || typeof m !== 'object') return false;

  const msg = m as Record<string, unknown>;
  const validRoles = ['system', 'user', 'assistant', 'tool', 'function'];

  if (!validRoles.includes(msg.role as string)) return false;

  // Allow null/undefined/empty content for assistant-with-tool_calls and tool/function role messages.
  // OpenAI spec: assistant messages invoking tools may carry content: null; tool results have content as string but may be empty.
  const isAssistantWithToolCalls =
    msg.role === 'assistant' && Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0;
  const isToolRole = msg.role === 'tool' || msg.role === 'function';
  if ((isAssistantWithToolCalls || isToolRole) && (msg.content === null || msg.content === undefined || msg.content === '')) {
    return true;
  }

  if (typeof msg.content === 'string') return true;

  if (Array.isArray(msg.content)) {
    return msg.content.every((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') return true;
      if (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object') return true;
      return false;
    });
  }

  return false;
};

// --- 9. GRACEFUL SHUTDOWN ---

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  console.log(`⏳ Waiting for ${inFlightRequests} in-flight requests...`);

  // Stop accepting new connections
  server.stop();

  // Wait for in-flight requests to complete
  const startTime = Date.now();
  while (inFlightRequests > 0 && (Date.now() - startTime) < CONFIG.shutdownTimeoutMs) {
    await sleep(100);
  }

  if (inFlightRequests > 0) {
    console.log(`⚠️  Timeout reached. ${inFlightRequests} requests will be terminated.`);
  } else {
    console.log('✅ All requests completed.');
  }

  console.log('👋 Goodbye!');
  process.exit(0);
};

// --- 10. SERVER ---

console.log(`🚀 Nexus AI Gateway v1.0 running on port ${CONFIG.port}`);
console.log(`🛡️  Active Providers: ${trackedServices.length}`);
console.log(`📊 Load Balancing: Health-Aware + Circuit Breaker`);
console.log(`🌐 CORS Origins: ${CONFIG.corsAllowedOrigins.join(', ')}`);
console.log(`⚡ Circuit Breaker: ${CONFIG.circuitBreaker.failureThreshold} failures -> OPEN for ${CONFIG.circuitBreaker.resetTimeoutMs / 1000}s`);

let dashboardHtml = '';

// =============================================================================
// DASHBOARD AUTH (login + signed session cookie)
// =============================================================================

/**
 * Dashboard auth is "enabled" when all three of email, password hash and
 * session secret are configured. Otherwise the dashboard remains public
 * (legacy behavior — printed once at startup as a warning).
 */
const DASHBOARD_AUTH_ENABLED =
  !!CONFIG.dashboardEmail && !!CONFIG.dashboardPasswordHash && !!CONFIG.dashboardSessionSecret;

if (!DASHBOARD_AUTH_ENABLED) {
  console.warn(
    '[Dashboard] Login disabled — set DASHBOARD_EMAIL, DASHBOARD_PASSWORD_HASH and ' +
    'DASHBOARD_SESSION_SECRET in .env to require authentication on /dashboard/*. ' +
    'Generate them with: bun run scripts/hash-password.ts <password>'
  );
} else {
  console.log(`🔐 Dashboard login required for ${CONFIG.dashboardEmail}`);
}

async function verifyDashboardPassword(password: string): Promise<boolean> {
  const stored = CONFIG.dashboardPasswordHash;
  if (!stored) return false;
  try {
    if (stored.startsWith('scrypt$')) {
      // Format: scrypt$<saltHex>$<hashHex>
      const parts = stored.split('$');
      if (parts.length !== 3) return false;
      const salt = Buffer.from(parts[1]!, 'hex');
      const expected = Buffer.from(parts[2]!, 'hex');
      const derived = scryptSync(password, salt, expected.length);
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    }
    // Bun.password.verify auto-detects bcrypt/argon2 from the hash prefix.
    const verify = (Bun as any)?.password?.verify;
    if (typeof verify === 'function') {
      return await verify(password, stored);
    }
    return false;
  } catch (err) {
    console.error('[Dashboard] verifyDashboardPassword error:', err);
    return false;
  }
}

function signDashboardSession(email: string, expiresAtMs: number): string {
  const session = `${email}.${expiresAtMs}`;
  const signature = createHmac('sha256', CONFIG.dashboardSessionSecret).update(session).digest('hex');
  return `${session}.${signature}`;
}

function verifyDashboardSession(req: Request): { valid: boolean; email?: string } {
  if (!DASHBOARD_AUTH_ENABLED) return { valid: true, email: '(auth-disabled)' };
  const cookieHeader = req.headers.get('Cookie') ?? '';
  const match = cookieHeader.match(/(?:^|;\s*)dashboard_session=([^;]+)/);
  if (!match) return { valid: false };

  let value: string;
  try {
    value = decodeURIComponent(match[1]!);
  } catch {
    return { valid: false };
  }
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0) return { valid: false };

  const session = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  const expected = createHmac('sha256', CONFIG.dashboardSessionSecret).update(session).digest('hex');

  let sigOk = false;
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    sigOk = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false };

  // session = "<email>.<expiresAtMs>"
  const sepIdx = session.lastIndexOf('.');
  if (sepIdx <= 0) return { valid: false };
  const email = session.slice(0, sepIdx);
  const expStr = session.slice(sepIdx + 1);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return { valid: false };

  return { valid: true, email };
}

function buildSessionCookie(value: string, isSecure: boolean): string {
  const parts = [
    `dashboard_session=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${CONFIG.dashboardSessionMaxAgeSec}`,
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearSessionCookie(isSecure: boolean): string {
  const parts = [
    'dashboard_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

function isHttpsRequest(req: Request, url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    req.headers.get('x-forwarded-proto')?.toLowerCase() === 'https'
  );
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function renderLoginPage(): string {
  // Inline page with the same design tokens as dashboard.html.
  return `<!doctype html>
<html lang="es" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Login · Nexus AI Gateway</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg:#0B0D10; --surface:#0F1115; --surface-2:#13161B;
    --border:#1A1D23; --border-strong:#252932;
    --text:#E6E8EB; --text-dim:#9AA0A6; --text-muted:#6B7280;
    --accent:#6BB4B0; --accent-soft:rgba(107,180,176,0.12); --accent-line:rgba(107,180,176,0.35);
    --error:#F0524A; --error-soft:rgba(240,82,74,0.12);
    --shadow-pop:0 1px 0 rgba(255,255,255,0.02) inset, 0 12px 32px -12px rgba(0,0,0,0.6);
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    font-size: 13px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    display: grid; place-items: center;
    padding: 24px;
  }
  .login-card {
    width: 100%; max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    box-shadow: var(--shadow-pop);
    padding: 28px 28px 24px;
  }
  .brand-row { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .brand-mark {
    width: 26px; height: 26px;
    border-radius: 7px;
    background: linear-gradient(135deg, var(--accent) 0%, color-mix(in oklab, var(--accent) 60%, #000) 100%);
    display: grid; place-items: center;
    color: #fff; font-weight: 700; font-size: 12px;
  }
  .brand-name { font-weight: 600; font-size: 15px; letter-spacing: -0.005em; }
  .brand-env { margin-left: auto; font-size: 10px; color: var(--text-muted); padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { font-size: 13px; color: var(--text-muted); margin: 0 0 20px; }
  .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .form-group label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); font-weight: 500; }
  input[type="email"], input[type="password"] {
    height: 36px;
    padding: 0 12px;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    transition: border-color 80ms;
  }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--text-muted); }
  button[type="submit"] {
    width: 100%;
    height: 36px;
    margin-top: 6px;
    background: var(--accent);
    color: #0B0D10;
    border: 1px solid var(--accent);
    border-radius: 7px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: filter 80ms;
  }
  button[type="submit"]:hover:not(:disabled) { filter: brightness(1.06); }
  button[type="submit"]:disabled { opacity: 0.6; cursor: progress; }
  .error {
    margin-top: 12px;
    padding: 8px 12px;
    background: var(--error-soft);
    border: 1px solid color-mix(in oklab, var(--error) 30%, transparent);
    border-radius: 6px;
    color: var(--error);
    font-size: 12px;
  }
  .footer { margin-top: 16px; text-align: center; color: var(--text-muted); font-size: 11px; }
</style>
</head>
<body>
  <div class="login-card">
    <div class="brand-row">
      <div class="brand-mark">N</div>
      <div class="brand-name">Nexus</div>
      <div class="brand-env">prod</div>
    </div>
    <h1>Acceder al dashboard</h1>
    <p class="sub">Solo administradores. Las sesiones duran 7 días.</p>
    <form id="loginForm" autocomplete="on">
      <div class="form-group">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" placeholder="you@example.com" required autofocus autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" placeholder="••••••••" required autocomplete="current-password">
      </div>
      <button id="submitBtn" type="submit">Entrar</button>
      <div id="error" class="error" hidden></div>
    </form>
    <div class="footer">Nexus AI Gateway</div>
  </div>
<script>
(function () {
  var form = document.getElementById('loginForm');
  var errorEl = document.getElementById('error');
  var btn = document.getElementById('submitBtn');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    try {
      var res = await fetch('/dashboard/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      if (res.ok) {
        var dest = new URLSearchParams(location.search).get('next') || '/dashboard';
        window.location.href = dest;
        return;
      }
      var msg = 'Credenciales inválidas';
      try { var data = await res.json(); if (data && data.error) msg = data.error; } catch (_) {}
      errorEl.textContent = msg;
      errorEl.hidden = false;
    } catch (_) {
      errorEl.textContent = 'No se pudo contactar al servidor';
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
})();
</script>
</body>
</html>`;
}

(async () => {
  try {
    dashboardHtml = await Bun.file('./dashboard.html').text();
  } catch {
    console.warn('[Dashboard] dashboard.html not found. GET /dashboard will return 404.');
  }
  await initDatabase();
  await refreshModelConfigCache();
  seedModels(trackedServices);
  seedApiKeys(providerKeyConfigs);
})();

const server = Bun.serve({
  port: CONFIG.port,
  // Increase idle timeout to allow long streaming responses
  idleTimeout: Number(process.env.IDLE_TIMEOUT_SECONDS) || 120,

  async fetch(req) {
    // Reject new requests during shutdown
    if (isShuttingDown) {
      return new Response(
        JSON.stringify({ error: { message: 'Server is shutting down', type: 'service_unavailable' } }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }
      );
    }

    const url = new URL(req.url);

    // --- SECURITY: CORS Whitelist ---
    const requestOrigin = req.headers.get('Origin') || '';
    const isWildcard = CONFIG.corsAllowedOrigins.includes('*');
    const isOriginAllowed = isWildcard ||
      CONFIG.corsAllowedOrigins.includes(requestOrigin) ||
      requestOrigin === 'null'; // file:// protocol sends 'null' as origin
    const corsHeaders = {
      'Access-Control-Allow-Origin': isWildcard ? '*' : (isOriginAllowed ? requestOrigin : ''),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Routing-Mode',
    };

    // CORS Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- DASHBOARD AUTH (login / logout) ------------------------------------
    // These three endpoints are always reachable so users can sign in/out.
    // Everything else under /dashboard/* is gated by the session check below.

    // Login form (GET)
    if (req.method === 'GET' && url.pathname === '/dashboard/login') {
      // If already signed in, bounce straight to the dashboard.
      if (DASHBOARD_AUTH_ENABLED && verifyDashboardSession(req).valid) {
        return new Response(null, { status: 302, headers: { Location: '/dashboard', ...corsHeaders } });
      }
      return new Response(renderLoginPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // Login submit (POST)
    if (req.method === 'POST' && url.pathname === '/dashboard/login') {
      if (!DASHBOARD_AUTH_ENABLED) {
        // Login is meaningless when auth is off; succeed quietly so the UI can move on.
        return new Response(JSON.stringify({ ok: true, authDisabled: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      let email = '';
      let password = '';
      try {
        const body = await req.json() as { email?: string; password?: string };
        email = (body?.email || '').trim().toLowerCase();
        password = body?.password || '';
      } catch {
        return new Response(
          JSON.stringify({ error: 'Invalid request body' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }

      // Constant-ish delay to mute timing attacks across both branches.
      const delay = new Promise(res => setTimeout(res, 200));
      const emailMatches = email === CONFIG.dashboardEmail;
      const passwordMatches = emailMatches && (await verifyDashboardPassword(password));
      await delay;

      if (!emailMatches || !passwordMatches) {
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }

      const expiresAtMs = Date.now() + CONFIG.dashboardSessionMaxAgeSec * 1000;
      const cookieValue = signDashboardSession(CONFIG.dashboardEmail, expiresAtMs);
      const setCookie = buildSessionCookie(cookieValue, isHttpsRequest(req, url));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie, ...corsHeaders },
      });
    }

    // Logout (POST)
    if (req.method === 'POST' && url.pathname === '/dashboard/logout') {
      const setCookie = buildClearSessionCookie(isHttpsRequest(req, url));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie, ...corsHeaders },
      });
    }

    // --- DASHBOARD SESSION GATE ----------------------------------------------
    // Every /dashboard/* path that isn't login/logout requires a valid signed
    // session cookie when DASHBOARD_AUTH_ENABLED. HTML navigations get a 302
    // back to /dashboard/login; XHR/fetch callers get a 401 JSON body.
    if (
      DASHBOARD_AUTH_ENABLED &&
      (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/'))
    ) {
      const session = verifyDashboardSession(req);
      if (!session.valid) {
        if (wantsHtml(req)) {
          const next = encodeURIComponent(url.pathname + (url.search || ''));
          return new Response(null, {
            status: 302,
            headers: { Location: `/dashboard/login?next=${next}`, ...corsHeaders },
          });
        }
        return new Response(
          JSON.stringify({ error: 'Unauthorized', loginRequired: true }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
    }

    // --- DASHBOARD ROUTES (now session-gated above when auth is enabled) -----

    // Serve dashboard HTML page
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      if (!dashboardHtml) {
        return new Response('Dashboard not available', { status: 404, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
      }
      return new Response(dashboardHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } });
    }

    // Dashboard summary
    if (req.method === 'GET' && url.pathname === '/dashboard/summary') {
      const dbClient = getDb();
      if (!dbClient) {
        return new Response(JSON.stringify({
          tokens_input_today: 0, tokens_output_today: 0, requests_today: 0, errors_today: 0,
          tokens_input_week: 0, tokens_output_week: 0, requests_week: 0,
          tokens_input_month: 0, tokens_output_month: 0, requests_month: 0,
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      try {
        const today = await dbClient.execute(`SELECT COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS to_, COUNT(*) AS req, COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS err FROM usage_logs WHERE date(timestamp)=date('now')`);
        const week = await dbClient.execute(`SELECT COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS to_, COUNT(*) AS req FROM usage_logs WHERE date(timestamp)>=date('now','-7 days')`);
        const month = await dbClient.execute(`SELECT COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS to_, COUNT(*) AS req FROM usage_logs WHERE date(timestamp)>=date('now','-30 days')`);
        const t = today.rows[0] as any; const w = week.rows[0] as any; const mo = month.rows[0] as any;
        return new Response(JSON.stringify({
          tokens_input_today: Number(t?.ti ?? 0), tokens_output_today: Number(t?.to_ ?? 0), requests_today: Number(t?.req ?? 0), errors_today: Number(t?.err ?? 0),
          tokens_input_week: Number(w?.ti ?? 0), tokens_output_week: Number(w?.to_ ?? 0), requests_week: Number(w?.req ?? 0),
          tokens_input_month: Number(mo?.ti ?? 0), tokens_output_month: Number(mo?.to_ ?? 0), requests_month: Number(mo?.req ?? 0),
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/summary]', err);
        return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard usage time-series
    if (req.method === 'GET' && url.pathname === '/dashboard/usage') {
      const dbClient = getDb();
      if (!dbClient) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      try {
        const period = url.searchParams.get('period') || 'daily';
        const days = Math.min(parseInt(url.searchParams.get('days') || '30') || 30, 365);
        const groupBy = period === 'weekly' ? `strftime('%Y-W%W', timestamp)` : `date(timestamp)`;
        const result = await dbClient.execute({
          sql: `SELECT ${groupBy} AS date, COALESCE(SUM(tokens_input),0) AS tokens_input, COALESCE(SUM(tokens_output),0) AS tokens_output, COUNT(*) AS requests, COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS errors FROM usage_logs WHERE date(timestamp)>=date('now',?) GROUP BY date ORDER BY date ASC`,
          args: [`-${days} days`],
        });
        return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/usage]', err);
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard usage by model
    if (req.method === 'GET' && url.pathname === '/dashboard/usage-by-model') {
      const dbClient = getDb();
      if (!dbClient) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      try {
        const days = Math.min(parseInt(url.searchParams.get('days') || '30') || 30, 365);
        const result = await dbClient.execute({
          sql: `SELECT model, COALESCE(SUM(tokens_input),0) AS tokens_input, COALESCE(SUM(tokens_output),0) AS tokens_output, COUNT(*) AS requests, COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS errors FROM usage_logs WHERE date(timestamp)>=date('now',?) GROUP BY model ORDER BY requests DESC`,
          args: [`-${days} days`],
        });
        return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/usage-by-model]', err);
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard usage by key
    if (req.method === 'GET' && url.pathname === '/dashboard/usage-by-key') {
      const dbClient = getDb();
      if (!dbClient) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      try {
        const days = Math.min(parseInt(url.searchParams.get('days') || '30') || 30, 365);
        const result = await dbClient.execute({
          sql: `SELECT k.id, k.label, COALESCE(SUM(u.tokens_input),0) AS tokens_input, COALESCE(SUM(u.tokens_output),0) AS tokens_output, COUNT(u.id) AS requests FROM usage_logs u LEFT JOIN api_keys k ON k.provider=u.provider AND k.active=1 WHERE date(u.timestamp)>=date('now',?) GROUP BY k.id ORDER BY requests DESC`,
          args: [`-${days} days`],
        });
        return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/usage-by-key]', err);
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard calls
    if (req.method === 'GET' && url.pathname === '/dashboard/calls') {
      const dbClient = getDb();
      if (!dbClient) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 500);
        const offset = parseInt(url.searchParams.get('offset') || '0') || 0;
        const success = url.searchParams.get('success');
        let where = '';
        const args: any[] = [];
        if (success !== null && success !== '') {
          where = 'WHERE success=?';
          args.push(parseInt(success));
        }
        const result = await dbClient.execute({
          sql: `SELECT id, timestamp, model, provider, tokens_input, tokens_output, duration_ms, success, error_message, error_code, origin_ip, referer, user_agent, request_preview, response_preview FROM usage_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
          args: [...args, limit, offset],
        });
        return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/calls]', err);
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard models CRUD
    if (req.method === 'GET' && url.pathname === '/dashboard/models') {
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        const result = await dbClient.execute('SELECT id, model_name, provider, active, created_at FROM model_config ORDER BY id');
        return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    if (req.method === 'POST' && url.pathname === '/dashboard/models') {
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        const body = await req.json() as { model_name?: string; provider?: string; active?: number };
        if (!body.model_name || !body.provider) {
          return new Response(JSON.stringify({ error: { message: 'model_name and provider are required' } }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        await dbClient.execute({
          sql: `INSERT INTO model_config (model_name, provider, active) VALUES (?, ?, ?) ON CONFLICT(model_name) DO UPDATE SET provider=excluded.provider, active=excluded.active`,
          args: [body.model_name, body.provider, body.active ?? 1],
        });
        await refreshModelConfigCache();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/models POST]', err);
        return new Response(JSON.stringify({ error: { message: 'Failed to save model config' } }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    const modelsByIdMatch = url.pathname.match(/^\/dashboard\/models\/(\d+)$/);
    if (modelsByIdMatch) {
      const id = parseInt(modelsByIdMatch[1]!);
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        if (req.method === 'PUT') {
          const body = await req.json() as { model_name?: string; provider?: string; active?: number };
          if (!body.model_name || !body.provider || body.active === undefined) {
            return new Response(JSON.stringify({ error: { message: 'model_name, provider, and active are required' } }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          }
          await dbClient.execute({
            sql: 'UPDATE model_config SET model_name=?, provider=?, active=? WHERE id=?',
            args: [body.model_name, body.provider, body.active, id],
          });
          await refreshModelConfigCache();
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        if (req.method === 'DELETE') {
          await dbClient.execute({ sql: 'DELETE FROM model_config WHERE id=?', args: [id] });
          await refreshModelConfigCache();
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
      } catch (err) {
        console.error('[Dashboard/models/:id]', err);
        return new Response(JSON.stringify({ error: { message: 'Failed' } }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // Dashboard api-keys CRUD
    if (req.method === 'GET' && url.pathname === '/dashboard/api-keys') {
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        const result = await dbClient.execute('SELECT id, provider, key_value, account_id, label, active, created_at FROM api_keys ORDER BY id');
        const rows = result.rows.map((r: any) => ({ ...r, key_value: maskKey(String(r.key_value)) }));
        return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify([]), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    if (req.method === 'POST' && url.pathname === '/dashboard/api-keys') {
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        const body = await req.json() as { provider?: string; key_value?: string; account_id?: string; label?: string };
        if (!body.provider || !body.key_value) {
          return new Response(JSON.stringify({ error: { message: 'provider and key_value are required' } }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        await dbClient.execute({
          sql: `INSERT INTO api_keys (provider, key_value, account_id, label) VALUES (?, ?, ?, ?)`,
          args: [body.provider, body.key_value, body.account_id || null, body.label || null],
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (err) {
        console.error('[Dashboard/api-keys POST]', err);
        return new Response(JSON.stringify({ error: { message: 'Failed to save API key' } }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    const keysByIdMatch = url.pathname.match(/^\/dashboard\/api-keys\/(\d+)$/);
    if (keysByIdMatch) {
      const id = parseInt(keysByIdMatch[1]!);
      const dbClient = getDb();
      if (!dbClient) return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
        if (req.method === 'PUT') {
          const body = await req.json() as { provider?: string; key_value?: string; account_id?: string; label?: string; active?: number };
          if (!body.provider || !body.key_value || body.active === undefined) {
            return new Response(JSON.stringify({ error: { message: 'provider, key_value, and active are required' } }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          }
          await dbClient.execute({
            sql: 'UPDATE api_keys SET provider=?, key_value=?, account_id=?, label=?, active=? WHERE id=?',
            args: [body.provider, body.key_value, body.account_id || null, body.label || null, body.active, id],
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        if (req.method === 'DELETE') {
          await dbClient.execute({ sql: 'DELETE FROM api_keys WHERE id=?', args: [id] });
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
      } catch (err) {
        console.error('[Dashboard/api-keys/:id]', err);
        return new Response(JSON.stringify({ error: { message: 'Failed' } }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // --- SECURITY: Authentication (master key OR per-user gateway token) ---
    // Skip auth for /health and /dashboard/* (the dashboard remains admin-only by
    // virtue of where it is hosted; admins are expected to put it behind a private
    // route or proxy). The /admin/* surface, by contrast, is strictly master-only.
    let authContext: AuthContext | null = null;
    const requiresAuth =
      CONFIG.masterKey &&
      url.pathname !== '/health' &&
      !url.pathname.startsWith('/dashboard');

    // Endpoints that must always be authenticated by the master key, never by a
    // per-user gateway token. Includes the new /admin/* surface and existing
    // mutation-only routes that change global gateway state.
    const adminOnlyPath =
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/v1/providers/toggle';

    if (requiresAuth) {
      const authHeader = req.headers.get('Authorization');
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

      // A valid dashboard session counts as MASTER for /admin/* — this lets
      // the logged-in dashboard call /admin/tokens without ever surfacing the
      // master key in the browser. The session cookie is HttpOnly + signed,
      // so it cannot be read or forged from JS. The cookie is NOT honored
      // for /v1/* (clients there must continue to use the bearer key).
      if (
        adminOnlyPath &&
        DASHBOARD_AUTH_ENABLED &&
        verifyDashboardSession(req).valid
      ) {
        authContext = { type: 'master' };
      }

      if (!authContext && !bearer) {
        return new Response(
          JSON.stringify({
            error: { message: 'Unauthorized: Invalid or missing API key', type: 'authentication_error' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }

      if (!authContext && bearer === CONFIG.masterKey) {
        authContext = { type: 'master' };
      } else if (!authContext && bearer && !adminOnlyPath) {
        // Try to resolve as a per-user gateway token. Only allowed on non-admin paths.
        const token = await findGatewayTokenBySecret(bearer);
        if (token && token.active === 1) {
          if (
            token.monthly_quota_tokens != null &&
            token.used_tokens_current_month >= token.monthly_quota_tokens
          ) {
            return new Response(
              JSON.stringify({
                error: {
                  message: `Monthly quota exceeded for token '${token.label}'`,
                  type: 'quota_exceeded',
                  label: token.label,
                  used: token.used_tokens_current_month,
                  quota: token.monthly_quota_tokens,
                },
              }),
              { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
            );
          }
          authContext = {
            type: 'token',
            tokenId: token.id,
            label: token.label,
            monthlyQuota: token.monthly_quota_tokens,
            used: token.used_tokens_current_month,
          };
        }
      }

      if (!authContext) {
        return new Response(
          JSON.stringify({
            error: { message: 'Unauthorized: Invalid or missing API key', type: 'authentication_error' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
    }

    // --- ADMIN: Per-user gateway token management (master-key OR dashboard session) ---
    // /admin/tokens* accepts either the master key (Authorization: Bearer)
    // or a valid dashboard session cookie. The auth block above resolves
    // both into authContext.type === 'master' before we reach these handlers.

    if (req.method === 'POST' && url.pathname === '/admin/tokens') {
      if (!getDb()) {
        return new Response(
          JSON.stringify({ error: { message: 'Database unavailable', type: 'service_unavailable' } }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      try {
        const body = await req.json() as {
          label?: string;
          monthlyQuotaTokens?: number | null;
          notes?: string | null;
        };
        if (!body || typeof body.label !== 'string' || !body.label.trim()) {
          return new Response(
            JSON.stringify({ error: { message: 'label is required', type: 'invalid_request_error' } }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }
        const created = await createGatewayToken(
          body.label,
          body.monthlyQuotaTokens === undefined ? null : body.monthlyQuotaTokens,
          body.notes === undefined ? null : body.notes,
        );
        return new Response(
          JSON.stringify({
            id: created.id,
            label: body.label.trim(),
            secret: created.secret,
            monthlyQuotaTokens:
              body.monthlyQuotaTokens == null ? null : Math.max(0, Math.floor(body.monthlyQuotaTokens)),
            quotaResetAt: created.quotaResetAt,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      } catch (err) {
        console.error('[Admin/tokens POST]', err);
        return new Response(
          JSON.stringify({ error: { message: 'Failed to create token', type: 'internal_error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
    }

    if (req.method === 'GET' && url.pathname === '/admin/tokens') {
      if (!getDb()) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      try {
        const tokens = await listGatewayTokens();
        return new Response(JSON.stringify(tokens), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        console.error('[Admin/tokens GET]', err);
        return new Response(JSON.stringify([]), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    const tokenByIdMatch = url.pathname.match(/^\/admin\/tokens\/(\d+)$/);
    if (tokenByIdMatch) {
      const tokenId = parseInt(tokenByIdMatch[1]!, 10);
      if (!getDb()) {
        return new Response(
          JSON.stringify({ error: { message: 'Database unavailable', type: 'service_unavailable' } }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }

      if (req.method === 'DELETE') {
        try {
          const result = await revokeGatewayToken(tokenId);
          if (!result) {
            return new Response(
              JSON.stringify({ error: { message: 'Token not found', type: 'not_found' } }),
              { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
            );
          }
          return new Response(JSON.stringify({ ok: true, label: result.label }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (err) {
          console.error('[Admin/tokens DELETE]', err);
          return new Response(
            JSON.stringify({ error: { message: 'Failed to revoke token', type: 'internal_error' } }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }
      }

      if (req.method === 'PATCH') {
        try {
          const body = await req.json() as {
            active?: boolean;
            monthlyQuotaTokens?: number | null;
            notes?: string | null;
          };
          const updated = await updateGatewayToken(tokenId, {
            active: body?.active,
            monthlyQuotaTokens: body?.monthlyQuotaTokens,
            notes: body?.notes,
          });
          if (!updated) {
            return new Response(
              JSON.stringify({ error: { message: 'Nothing to update or token not found', type: 'invalid_request_error' } }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
            );
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (err) {
          console.error('[Admin/tokens PATCH]', err);
          return new Response(
            JSON.stringify({ error: { message: 'Failed to update token', type: 'internal_error' } }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }
      }
    }

    if (req.method === 'POST' && url.pathname.match(/^\/admin\/tokens\/(\d+)\/reset-usage$/)) {
      const m = url.pathname.match(/^\/admin\/tokens\/(\d+)\/reset-usage$/)!;
      const tokenId = parseInt(m[1]!, 10);
      if (!getDb()) {
        return new Response(
          JSON.stringify({ error: { message: 'Database unavailable', type: 'service_unavailable' } }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      try {
        const ok = await resetGatewayTokenUsage(tokenId);
        if (!ok) {
          return new Response(
            JSON.stringify({ error: { message: 'Token not found', type: 'not_found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        console.error('[Admin/tokens reset-usage]', err);
        return new Response(
          JSON.stringify({ error: { message: 'Failed to reset usage', type: 'internal_error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
    }

    // Provider enable/disable toggle
    if (req.method === 'POST' && url.pathname === '/v1/providers/toggle') {
      try {
        const body = await req.json() as { name?: string; enabled?: boolean };

        if (!body?.name || typeof body.enabled !== 'boolean') {
          return new Response(
            JSON.stringify({ error: { message: 'Missing name or enabled flag', type: 'invalid_request_error' } }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }

        const target = trackedServices.find(ts => ts.service.name === body.name);
        if (!target) {
          return new Response(
            JSON.stringify({ error: { message: 'Provider not found', type: 'not_found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }

        target.enabled = body.enabled;

        const responseBody = {
          name: target.service.name,
          provider: target.service.provider,
          enabled: target.enabled,
        };

        return new Response(JSON.stringify(responseBody), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (error) {
        console.error('[Toggle Provider] Error parsing request', error);
        return new Response(
          JSON.stringify({ error: { message: 'Invalid JSON payload', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
    }

    // Health Check
    if (req.method === 'GET' && url.pathname === '/health') {
      const healthData = {
        status: isShuttingDown ? 'shutting_down' : 'healthy',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        inFlightRequests,
        config: {
          corsAllowedOrigins: CONFIG.corsAllowedOrigins,
          firstTokenTimeoutMs: CONFIG.firstTokenTimeoutMs,
          circuitBreaker: CONFIG.circuitBreaker,
          backoff: CONFIG.backoff,
        },
        providers: trackedServices.map(ts => {
          const total = ts.metrics.totalRequests || 0;
          const success = ts.metrics.successCount || 0;
          const fail = ts.metrics.failCount || 0;
          const skip = ts.metrics.skipCount || 0;
          const latency = ts.metrics.totalLatencyMs || 0;
          const rateDenom = success + fail; // Exclude skips from success-rate denominator
          return {
            name: ts.service.name,
            provider: ts.service.provider,
            circuitState: ts.circuitBreaker.state,
            metrics: {
              totalRequests: total,
              successCount: success,
              failCount: fail,
              skipCount: skip,
              successRate: rateDenom > 0 ? `${((success / rateDenom) * 100).toFixed(1)}%` : 'N/A',
              avgLatency: total > 0 ? Math.round(latency / total) : 0,
              healthScore: `${(calculateHealthScore(ts) * 100).toFixed(1)}%`,
              consecutiveFailures: ts.circuitBreaker.failures,
              lastError: ts.metrics.lastError || null,
            },
            enabled: ts.enabled, // Expose enabled state
          };
        }),
      };

      return new Response(JSON.stringify(healthData, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Models endpoint
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const models = {
        object: 'list',
        data: [
          {
            id: 'auto',
            object: 'model',
            owned_by: 'nexus',
            available: true,
          },
          ...trackedServices.map(ts => ({
            id: ts.service.name,
            object: 'model',
            owned_by: ts.service.provider,
            available: ts.enabled && isServiceAvailable(ts),
          })),
        ],
      };

      return new Response(JSON.stringify(models), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Chat Completions
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      inFlightRequests++;
      let hasDecrementedInFlight = false;

      const referer = req.headers.get('referer') || '';
      const userAgent = req.headers.get('user-agent') || '';

      const decrementInFlight = () => {
        if (!hasDecrementedInFlight) {
          hasDecrementedInFlight = true;
          inFlightRequests--;
        }
      };

      try {
        const body = await req.json() as {
          messages?: unknown;
          stream?: boolean;
          model?: string;
          tools?: unknown;
          tool_choice?: unknown;
          temperature?: number;
          top_p?: number;
          max_tokens?: number;
          presence_penalty?: number;
          frequency_penalty?: number;
          stop?: string | string[];
        };
        const messages = body.messages;

        // TEMP DEBUG: unconditional request summary at handler entry to diagnose
        // 400 "Invalid messages format" that never reaches provider-level logs.
        try {
          const msgArr = Array.isArray(messages) ? messages as any[] : undefined;
          const summary = JSON.stringify({
            model: body.model,
            messages_count: msgArr?.length,
            last_message: msgArr?.[msgArr.length - 1],
            messages_summary: msgArr?.map((m: any) => ({
              role: m?.role,
              content_type: Array.isArray(m?.content) ? 'array' : typeof m?.content,
              has_tool_calls: !!m?.tool_calls,
              tool_call_id: m?.tool_call_id,
            })),
            tools_count: Array.isArray(body.tools) ? (body.tools as unknown[]).length : undefined,
            tool_choice: body.tool_choice,
          });
          console.warn('[IncomingRequest-Start]', summary.slice(0, 2500));
        } catch (logErr) {
          console.warn('[IncomingRequest-Start] <serialize-failed>', logErr);
        }

        if (!Array.isArray(messages) || !messages.every(isValidMessage)) {
          inFlightRequests--;
          hasDecrementedInFlight = true;
          const errorBody = JSON.stringify({ error: { message: 'Invalid messages format', type: 'invalid_request_error' } });
          console.warn('[GatewayReturningError]', 400, errorBody);
          return new Response(
            errorBody,
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        const typedMessages = messages as ChatMessage[];
        const requestPreview = extractRequestPreview(messages);
        const requestId = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const encoder = new TextEncoder();
        const routingModeHeader = (req.headers.get('x-routing-mode') || 'smart').toLowerCase();
        const routingMode: 'smart' | 'fastest' | 'round-robin' =
          routingModeHeader === 'fastest' || routingModeHeader === 'round-robin'
            ? routingModeHeader
            : 'smart';

        let aborted = false;
        const triedIndices = new Set<number>();
        // TEMP DEBUG: once-per-request flag to log provider 4xx details for the
        // "Invalid messages format" investigation in the Wallex tool-use loop.
        let debug4xxLogged = false;
        const log4xxOnce = (serviceName: string, status: number, err: unknown, resolvedModel: string | undefined) => {
          if (debug4xxLogged) return;
          debug4xxLogged = true;
          const errBody = extractErrorBody(err).slice(0, 500);
          let msgs = '';
          try { msgs = JSON.stringify(body.messages).slice(0, 2000); } catch { msgs = '<unserializable>'; }
          const toolsCount = Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0;
          const toolChoice =
            typeof body.tool_choice === 'string'
              ? body.tool_choice
              : body.tool_choice === undefined
                ? '(none)'
                : (() => { try { return JSON.stringify(body.tool_choice); } catch { return '<unserializable>'; } })();
          console.warn(`[ProviderErrorBody] ${serviceName} status=${status} body=${errBody}`);
          console.warn(`[IncomingRequest] messages=${msgs} tools_count=${toolsCount} tool_choice=${toolChoice} model=${resolvedModel ?? '(none)'}`);
        };

        const onAbort = () => { aborted = true; };
        req.signal?.addEventListener?.('abort', onAbort, { once: true } as EventListenerOptions);

        const streamRequested = body.stream !== false;
        const chatOptions = {
          model: body.model,
          tools: body.tools,
          tool_choice: body.tool_choice,
          temperature: body.temperature,
          top_p: body.top_p,
          max_tokens: body.max_tokens,
          presence_penalty: body.presence_penalty,
          frequency_penalty: body.frequency_penalty,
          stop: body.stop,
        };

        const route: ResolvedRoute = resolveRoute(body.model);
        let resolvedAllowedProviders: ReadonlySet<ProviderType> = route.providers;
        const configuredProviders = new Set(trackedServices.map(ts => ts.service.provider));
        // Skip the model_config override for the 'auto' pseudo-model (the router
        // already returns the full universal fallback set with stripModel=true)
        // and for any cached entry whose provider isn't actually configured —
        // otherwise a stale row like ('auto','auto') would narrow the route to
        // a phantom provider and yield "No compatible provider configured".
        const isAutoPseudoModel = typeof body.model === 'string' && body.model.trim().toLowerCase() === 'auto';
        const modelConfigProvider = body.model && !isAutoPseudoModel ? getCachedModelProvider(body.model) : undefined;
        if (modelConfigProvider && configuredProviders.has(modelConfigProvider)) {
          resolvedAllowedProviders = new Set([modelConfigProvider]);
          console.log(`[ModelConfig] Overriding route for '${body.model}' -> provider '${modelConfigProvider}'`);
        } else if (modelConfigProvider) {
          console.warn(`[ModelConfig] Ignoring stale model_config row '${body.model}' -> '${modelConfigProvider}' (provider not configured); falling back to router route '${route.ruleLabel}'`);
        }
        const allowedProviders = resolvedAllowedProviders;
        const modelAliases = route.modelAliases;
        const compatibleProviders = [...allowedProviders].filter(p => configuredProviders.has(p));
        const candidateList = trackedServices
          .filter(ts => allowedProviders.has(ts.service.provider))
          .map(ts => ts.service.name);

        console.log(`[Router] model=${body.model || '(default)'} rule=${route.ruleLabel} candidates=[${candidateList.join(', ') || 'none'}]`);

        if (compatibleProviders.length === 0) {
          inFlightRequests--;
          hasDecrementedInFlight = true;
          const supported = [...configuredProviders].join(', ');
          const noCompatBody = JSON.stringify({
            error: {
              message: `No compatible provider is configured for model '${body.model}'. Available providers: ${supported}.`,
              type: 'invalid_request_error',
              param: 'model',
            },
          });
          console.warn('[GatewayReturningError]', 400, noCompatBody);
          return new Response(
            noCompatBody,
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }

        // Resolve a display-name pin ("Groq (Key #2)") to a specific tracked service.
        // Case-insensitive match on .service.name (since display names are constructed
        // as `${displayName} (Key #${instanceId})` and callers may echo back variant casing).
        let pinnedTracked: EnhancedTrackedService | null = null;
        if (route.pinnedServiceName) {
          const wanted = route.pinnedServiceName.trim().toLowerCase();
          pinnedTracked = trackedServices.find(
            ts => ts.service.name.toLowerCase() === wanted,
          ) ?? null;
          if (!pinnedTracked) {
            inFlightRequests--;
            hasDecrementedInFlight = true;
            const unknownBody = JSON.stringify({
              error: {
                message: `Unknown model '${body.model}'. No provider instance with that display name is configured.`,
                type: 'invalid_request_error',
                param: 'model',
              },
            });
            console.warn('[GatewayReturningError]', 400, unknownBody);
            return new Response(
              unknownBody,
              { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
            );
          }
          if (!pinnedTracked.enabled || !isServiceAvailable(pinnedTracked)) {
            inFlightRequests--;
            hasDecrementedInFlight = true;
            const state = pinnedTracked.circuitBreaker.state;
            const unavailBody = JSON.stringify({
              error: {
                message: `pinned model ${pinnedTracked.service.name} unavailable: circuit ${state}`,
                type: 'service_unavailable',
                param: 'model',
              },
            });
            console.warn('[GatewayReturningError]', 503, unavailBody);
            return new Response(
              unavailBody,
              { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
            );
          }
          // Strip the display-name string so base.ts:69 falls back to the service's default model.
          chatOptions.model = undefined;
        }

        if (!streamRequested) {
          const triedIndices = new Set<number>();
          let attemptNumber = 0;

          while (triedIndices.size < trackedServices.length) {
            const tracked = pinnedTracked
              ? (triedIndices.has(trackedServices.indexOf(pinnedTracked)) ? null : pinnedTracked)
              : getNextService(triedIndices, routingMode, allowedProviders);
            if (!tracked) {
              if (attemptNumber === 0) {
                console.warn(`[Router] All candidates circuit-OPEN for rule=${route.ruleLabel}, model=${body.model ?? '(default)'}`);
              }
              break;
            }

            attemptNumber++;
            const serviceIndex = trackedServices.indexOf(tracked);
            triedIndices.add(serviceIndex);

            if (attemptNumber > 1) {
              const backoffDelay = calculateBackoffDelay(attemptNumber - 1);
              await sleep(backoffDelay);
            }

            const service = tracked.service;
            const startTime = Date.now();
            tracked.metrics.totalRequests++;

            // Apply per-provider model alias when the original model string is
            // incompatible with this provider (e.g. "openai/gpt-4.1-mini" -> Groq).
            // Strip the outgoing model for "auto" routes and display-name pins so
            // the upstream service falls back to its own default model.
            const shouldStripModel = route.stripModel || !!route.pinnedServiceName;
            const alias = modelAliases[service.provider];
            const serviceOptions = shouldStripModel
              ? { ...chatOptions, model: undefined }
              : alias
                ? { ...chatOptions, model: alias }
                : chatOptions;

            try {
              const completion = service.createChatCompletion
                ? await service.createChatCompletion(typedMessages, serviceOptions)
                : await (async () => {
                    // Fallback to streaming if provider lacks non-streaming
                    let full = '';
                    for await (const chunk of service.chat(typedMessages, serviceOptions)) {
                      full += chunk;
                    }
                    return {
                      id: requestId,
                      object: 'chat.completion',
                      created,
                      model: service.name,
                      choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
                    };
                  })();

              tracked.metrics.successCount++;
              tracked.metrics.totalLatencyMs += Date.now() - startTime;
              recordSuccess(tracked);

              const usage = (completion as any)?.usage;
              const originIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
              const responsePreview = extractResponsePreview(
                (completion as any)?.choices?.[0]?.message
              );
              const tokensIn = usage?.prompt_tokens ?? 0;
              const tokensOut = usage?.completion_tokens ?? 0;
              const tokenIdAttr = authContext?.type === 'token' ? authContext.tokenId : null;
              logUsage({
                model: serviceOptions.model || service.name,
                provider: service.provider,
                tokensInput: tokensIn,
                tokensOutput: tokensOut,
                durationMs: Date.now() - startTime,
                success: 1,
                originIp,
                referer,
                userAgent,
                requestPreview,
                responsePreview,
                tokenId: tokenIdAttr,
              });
              if (tokenIdAttr != null) {
                void incrementTokenUsage(tokenIdAttr, tokensIn + tokensOut);
              }

              return new Response(JSON.stringify(completion), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const status = extractHttpStatus(err);
              if (status === 404) {
                console.error(`[Router] 404 from ${service.name} for model='${body.model}'. Provider misconfigured for this model; skipping.`);
              } else if (status === 402) {
                console.warn(`[Router] 402 insufficient credits on ${service.name}; moving to next compatible key.`);
              } else if (status === 429) {
                const retry = extractRetryAfter(err);
                console.warn(`[Router] 429 rate-limited on ${service.name}${retry ? ` (retry-after=${retry}s)` : ''}; moving to next compatible key.`);
              }
              // TEMP DEBUG: surface provider bad-status body + incoming request for repro (4xx and 5xx).
              if (typeof status === 'number' && status >= 400) {
                log4xxOnce(service.name, status, err, serviceOptions.model);
              }
              tracked.metrics.failCount++;
              tracked.metrics.lastError = errorMsg;
              tracked.metrics.lastErrorTime = Date.now();
              tracked.metrics.totalLatencyMs += Date.now() - startTime;
              recordFailure(tracked);

              const failOriginIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
              logUsage({
                model: serviceOptions.model || service.name,
                provider: service.provider,
                tokensInput: 0,
                tokensOutput: 0,
                durationMs: Date.now() - startTime,
                success: 0,
                errorMessage: errorMsg,
                errorCode: status ? String(status) : undefined,
                originIp: failOriginIp,
                referer,
                userAgent,
                requestPreview,
                tokenId: authContext?.type === 'token' ? authContext.tokenId : null,
              });
            }
          }

          const gatewayErrorBody = JSON.stringify({
            error: {
              message: route.isUniversal
                ? 'All providers failed or circuits are open'
                : `All compatible providers failed for model '${body.model}' (rule: ${route.ruleLabel})`,
              type: 'gateway_error',
            },
          });
          console.warn('[GatewayReturningError]', 502, gatewayErrorBody);
          return new Response(
            gatewayErrorBody,
            { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        const stream = new ReadableStream({
          async start(controller) {
            let controllerClosed = false;
            let responseContent = '';
            // Accumulator for streamed tool_call deltas, indexed by `delta.index`.
            // Mirrors the typical OpenAI streaming pattern (id/name arrive once,
            // then `arguments` arrives as a sequence of string fragments to
            // concatenate). Used solely for `response_preview` telemetry — the
            // client-facing SSE stream is unchanged.
            const toolCallAcc: Map<number, { id?: string; name?: string; arguments: string }> = new Map();
            // Tracks the most recent provider that successfully emitted a
            // chunk to the client. Used so the final `finish_reason` chunk
            // we synthesize after the stream ends carries the right model
            // string.
            let lastEmittedServiceName: string | null = null;
            const flattenedToolCalls = (): Array<{ name?: string; arguments?: string }> => {
              return Array.from(toolCallAcc.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, v]) => ({ name: v.name, arguments: v.arguments }));
            };
            const safeEnqueue = (chunk: Uint8Array) => {
              if (controllerClosed) return;
              try {
                controller.enqueue(chunk);
              } catch {
                controllerClosed = true;
              }
            };

            const safeClose = () => {
              if (controllerClosed) return;
              controllerClosed = true;
              try {
                controller.close();
              } catch {
                // ignore
              }
            };

            try {
              let started = false;
              let attemptNumber = 0;

              const emitChunk = (service: AIService, chunk: ChatStreamChunk) => {
                if (typeof chunk !== 'string') {
                  if (chunk?.type === 'tool_call_delta') {
                    // Telemetry accumulator (used for response_preview).
                    const idx = chunk.index;
                    const existing = toolCallAcc.get(idx) ?? { arguments: '' };
                    if (chunk.id !== undefined) existing.id = chunk.id;
                    if (chunk.name !== undefined) existing.name = chunk.name;
                    if (chunk.arguments) existing.arguments += chunk.arguments;
                    toolCallAcc.set(idx, existing);

                    // Forward the delta to the client as a standard OpenAI
                    // streaming `tool_calls` chunk. The first delta for a
                    // given index typically carries `id` + `name`; subsequent
                    // deltas carry `arguments` fragments that the client
                    // concatenates. Only include fields that are actually
                    // present in this delta — never emit undefined.
                    const hasFunctionFields = chunk.name !== undefined || chunk.arguments !== undefined;
                    const toolCallDelta: Record<string, unknown> = { index: chunk.index };
                    if (chunk.id !== undefined) toolCallDelta.id = chunk.id;
                    if (hasFunctionFields) {
                      toolCallDelta.type = 'function';
                      const fn: Record<string, unknown> = {};
                      if (chunk.name !== undefined) fn.name = chunk.name;
                      if (chunk.arguments !== undefined) fn.arguments = chunk.arguments;
                      toolCallDelta.function = fn;
                    }
                    const data = {
                      id: requestId,
                      object: 'chat.completion.chunk',
                      created,
                      model: service.name,
                      choices: [{
                        delta: { tool_calls: [toolCallDelta] },
                        index: 0,
                        finish_reason: null,
                      }],
                    };
                    safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    lastEmittedServiceName = service.name;
                  }
                  return;
                }
                const content = chunk;
                responseContent += content;
                const data = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created,
                  model: service.name,
                  choices: [{ delta: { content }, index: 0, finish_reason: null }],
                };
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                lastEmittedServiceName = service.name;
              };

              const emitError = (message: string) => {
                safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'gateway_error' } })}\n\n`));
              };

              // Try each service with exponential backoff
              while (triedIndices.size < trackedServices.length && !aborted) {
                const tracked = pinnedTracked
                  ? (triedIndices.has(trackedServices.indexOf(pinnedTracked)) ? null : pinnedTracked)
                  : getNextService(triedIndices, routingMode, allowedProviders);
                if (!tracked) {
                  // All circuits might be open - wait and check again
                  if (attemptNumber > 0 && !pinnedTracked) {
                    const backoffDelay = calculateBackoffDelay(attemptNumber);
                    console.log(`[Router] All available circuits tried. Waiting ${backoffDelay}ms before checking again...`);
                    await sleep(backoffDelay);

                    // Check if any circuit has reopened among compatible providers
                    const reopened = trackedServices.some((ts, idx) =>
                      !triedIndices.has(idx)
                      && allowedProviders.has(ts.service.provider)
                      && isServiceAvailable(ts)
                    );
                    if (!reopened) break;
                    continue;
                  }
                  console.warn(`[Router] All candidates circuit-OPEN for rule=${route.ruleLabel}, model=${body.model ?? '(default)'}`);
                  break;
                }

                attemptNumber++;
                const serviceIndex = trackedServices.indexOf(tracked);
                triedIndices.add(serviceIndex);

                // Apply backoff delay between retries (not on first attempt)
                if (attemptNumber > 1) {
                  const backoffDelay = calculateBackoffDelay(attemptNumber - 1);
                  console.log(`[Router] Backoff: waiting ${backoffDelay}ms before attempt ${attemptNumber}`);
                  await sleep(backoffDelay);
                }

                const service = tracked.service;
                const startTime = Date.now();

                // Apply per-provider model alias when the original model string is
                // incompatible with this provider (e.g. "openai/gpt-4.1-mini" -> Groq).
                // Strip the outgoing model for "auto" routes and display-name pins so
                // the upstream service falls back to its own default model.
                const shouldStripModel = route.stripModel || !!route.pinnedServiceName;
                const streamAlias = modelAliases[service.provider];
                const streamOptions = shouldStripModel
                  ? { ...chatOptions, model: undefined }
                  : streamAlias
                    ? { ...chatOptions, model: streamAlias }
                    : chatOptions;

                // Track half-open attempts
                if (tracked.circuitBreaker.state === 'HALF_OPEN') {
                  tracked.circuitBreaker.halfOpenAttempts++;
                }

                console.log(`[Router] Attempt ${attemptNumber}/${trackedServices.length} -> ${service.name} [${tracked.circuitBreaker.state}] mode=${routingMode}`);
                tracked.metrics.totalRequests++;

                try {
                  const gen = service.chat(typedMessages, streamOptions);

                  // First-token timeout.
                  // On timeout rejection: the outer `catch (err)` below records
                  // the provider failure (failCount++, recordFailure) and the
                  // `finally` at the end of start() calls decrementInFlight().
                  // The idempotency flag on decrementInFlight() guarantees no
                  // double-decrement even if `cancel()` fires later because the
                  // Response has already been returned to the client.
                  // We additionally close the pending generator so the upstream
                  // fetch doesn't keep running in the background after timeout.
                  const firstResult = await (async () => {
                    if (started || CONFIG.firstTokenTimeoutMs <= 0) {
                      return gen.next();
                    }

                    let timeoutId: ReturnType<typeof setTimeout> | undefined;
                    let timedOut = false;
                    try {
                      const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(
                          () => {
                            timedOut = true;
                            reject(new Error(`First token timeout after ${CONFIG.firstTokenTimeoutMs}ms`));
                          },
                          CONFIG.firstTokenTimeoutMs
                        );
                      });
                      return await Promise.race([gen.next(), timeoutPromise]);
                    } finally {
                      if (timeoutId) clearTimeout(timeoutId);
                      if (timedOut) {
                        // Best-effort: release the abandoned generator so the
                        // upstream HTTP request is cancelled.
                        try { void gen.return?.(undefined); } catch { /* ignore */ }
                      }
                    }
                  })();

                  const includeMetadataQuery = url.searchParams.get('include_metadata') === 'true';
                  const includeMetadataHeader = (req.headers.get('x-nexus-include-metadata') || '').toLowerCase() === 'true';
                  const includeMetadata = includeMetadataQuery || includeMetadataHeader;
                  const emitMetadata = (service: AIService, latency: number, circuitState: string, health: number) => {
                    if (!includeMetadata) return;
                    const metadata = {
                      type: 'nexus-metadata',
                      metadata: {
                        provider: service.name,
                        latency: latency,
                        circuit: circuitState,
                        healthScore: Math.round(health * 100),
                        requestId: requestId,
                      }
                    };
                    safeEnqueue(encoder.encode(`data: ${JSON.stringify(metadata)}\n\n`));
                  };

                  if (aborted) break;

                  if (!firstResult.done && firstResult.value) {
                    started = true;
                    console.log(`[Router] Streaming started with: ${service.name}`);
                    // Emit metadata before first chunk
                    emitMetadata(
                      service,
                      Date.now() - startTime,
                      tracked.circuitBreaker.state,
                      calculateHealthScore(tracked)
                    );
                    emitChunk(service, firstResult.value);
                  } else if (firstResult.done) {
                    started = true;
                    tracked.metrics.successCount++;
                    tracked.metrics.totalLatencyMs += Date.now() - startTime;
                    recordSuccess(tracked);
                    const streamUsage1 = (service as any).lastStreamUsage;
                    const streamOriginIp1 = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                    const stream1In = streamUsage1?.prompt_tokens ?? 0;
                    const stream1Out = streamUsage1?.completion_tokens ?? 0;
                    const stream1TokenId = authContext?.type === 'token' ? authContext.tokenId : null;
                    logUsage({
                      model: streamOptions.model || service.name,
                      provider: service.provider,
                      tokensInput: stream1In,
                      tokensOutput: stream1Out,
                      durationMs: Date.now() - startTime,
                      success: 1,
                      originIp: streamOriginIp1,
                      referer,
                      userAgent,
                      requestPreview,
                      responsePreview: extractResponsePreview(undefined, responseContent, flattenedToolCalls()),
                      tokenId: stream1TokenId,
                    });
                    if (stream1TokenId != null) {
                      void incrementTokenUsage(stream1TokenId, stream1In + stream1Out);
                    }
                    // Emit metadata for non-streaming response too
                    emitMetadata(
                      service,
                      Date.now() - startTime,
                      tracked.circuitBreaker.state,
                      calculateHealthScore(tracked)
                    );
                    break;
                  }

                  for await (const chunk of gen) {
                    if (aborted) break;
                    if (chunk) {
                      if (!started) {
                        started = true;
                        console.log(`[Router] Streaming started with: ${service.name}`);
                        emitMetadata(
                          service,
                          Date.now() - startTime,
                          tracked.circuitBreaker.state,
                          calculateHealthScore(tracked)
                        );
                      }
                      emitChunk(service, chunk);
                    }
                  }

                  if (started) {
                    tracked.metrics.successCount++;
                    tracked.metrics.totalLatencyMs += Date.now() - startTime;
                    recordSuccess(tracked);
                    const streamUsage2 = (service as any).lastStreamUsage;
                    const streamOriginIp2 = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                    const stream2In = streamUsage2?.prompt_tokens ?? 0;
                    const stream2Out = streamUsage2?.completion_tokens ?? 0;
                    const stream2TokenId = authContext?.type === 'token' ? authContext.tokenId : null;
                    logUsage({
                      model: streamOptions.model || service.name,
                      provider: service.provider,
                      tokensInput: stream2In,
                      tokensOutput: stream2Out,
                      durationMs: Date.now() - startTime,
                      success: 1,
                      originIp: streamOriginIp2,
                      referer,
                      userAgent,
                      requestPreview,
                      responsePreview: extractResponsePreview(undefined, responseContent, flattenedToolCalls()),
                      tokenId: stream2TokenId,
                    });
                    if (stream2TokenId != null) {
                      void incrementTokenUsage(stream2TokenId, stream2In + stream2Out);
                    }
                    break;
                  }
                } catch (err) {
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  const status = extractHttpStatus(err);
                  console.error(`[Provider Error] ${service.name} status=${status ?? 'n/a'}:`, errorMsg);
                  if (status === 404) {
                    console.error(`[Router] 404 from ${service.name} for model='${body.model}'. Provider misconfigured for this model; skipping.`);
                  } else if (status === 402) {
                    console.warn(`[Router] 402 insufficient credits on ${service.name}; moving to next compatible key.`);
                  } else if (status === 429) {
                    const retry = extractRetryAfter(err);
                    console.warn(`[Router] 429 rate-limited on ${service.name}${retry ? ` (retry-after=${retry}s)` : ''}; moving to next compatible key.`);
                  }
                  // TEMP DEBUG: surface provider bad-status body + incoming request for repro (4xx and 5xx).
                  if (typeof status === 'number' && status >= 400) {
                    log4xxOnce(service.name, status, err, streamOptions.model);
                  }

                  tracked.metrics.failCount++;
                  tracked.metrics.lastError = errorMsg;
                  tracked.metrics.lastErrorTime = Date.now();
                  tracked.metrics.totalLatencyMs += Date.now() - startTime;
                  recordFailure(tracked);

                  const streamFailOriginIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
                  logUsage({
                    model: streamOptions.model || service.name,
                    provider: service.provider,
                    tokensInput: 0,
                    tokensOutput: 0,
                    durationMs: Date.now() - startTime,
                    success: 0,
                    errorMessage: errorMsg,
                    errorCode: status ? String(status) : undefined,
                    originIp: streamFailOriginIp,
                    referer,
                    userAgent,
                    requestPreview,
                    responsePreview: (() => {
                      const preview = extractResponsePreview(undefined, responseContent, flattenedToolCalls());
                      return preview === '(empty response)' ? undefined : preview;
                    })(),
                    tokenId: authContext?.type === 'token' ? authContext.tokenId : null,
                  });

                  if (started) break;
                }
              }

              if (!started && !aborted) {
                const streamErrMsg = route.isUniversal
                  ? 'All providers failed or circuits are open'
                  : `All compatible providers failed for model '${body.model}' (rule: ${route.ruleLabel})`;
                console.warn('[GatewayReturningError]', 'stream', streamErrMsg);
                emitError(streamErrMsg);
              }

              // If the upstream stream finished with tool_calls, synthesize
              // a final chunk carrying `finish_reason: 'tool_calls'` so the
              // client (e.g. Wallex's _ToolCallAccumulator) knows the
              // tool-calling phase is complete. Provider deltas in this
              // gateway always carry `finish_reason: null`, so without this
              // chunk the client never sees the terminal signal before
              // `[DONE]`.
              if (started && !aborted && toolCallAcc.size > 0) {
                const finalData = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created,
                  model: lastEmittedServiceName ?? body.model ?? 'unknown',
                  choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }],
                };
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(finalData)}\n\n`));
              }

              safeEnqueue(encoder.encode('data: [DONE]\n\n'));
              safeClose();
            } catch (err) {
              console.error('[Stream Error]', err);
              try {
                safeEnqueue(encoder.encode('data: [DONE]\n\n'));
              } catch { /* ignore */ }
              safeClose();
            } finally {
              req.signal?.removeEventListener?.('abort', onAbort);
              decrementInFlight();
            }
          },
          cancel() {
            aborted = true;
            req.signal?.removeEventListener?.('abort', onAbort);
            decrementInFlight();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders,
          },
        });
      } catch (error) {
        if (!hasDecrementedInFlight) {
          hasDecrementedInFlight = true;
          inFlightRequests--;
        }
        console.error('Internal Server Error:', error);
        const internalBody = JSON.stringify({ error: { message: 'Internal Error', type: 'internal_error' } });
        console.warn('[GatewayReturningError]', 500, internalBody);
        return new Response(
          internalBody,
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      } finally {
        decrementInFlight();
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
});

// Register shutdown handlers (after server is created)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));