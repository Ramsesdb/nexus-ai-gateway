/**
 * Nexus AI Gateway v1.0 - Production-Ready AI Proxy
 * Features: Health-aware load balancing, Circuit Breaker, Graceful Shutdown
 */

import { GroqService } from './services/groq';
import { GeminiService } from './services/gemini';
import { OpenRouterService } from './services/openrouter';
import { CerebrasService } from './services/cerebras';
import { CloudflareService } from './services/cloudflare';
import { resolveRoute, type ResolvedRoute } from './services/router';
import type {
  AIService,
  ChatMessage,
  ProviderType,
  ServiceMetrics,
  TrackedService,
} from './types';

// --- 1. CONFIGURATION ---
const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  firstTokenTimeoutMs: Number(process.env.FIRST_TOKEN_TIMEOUT_MS) || 8000,

  // Security: Master API Key (optional, but highly recommended for production)
  masterKey: process.env.NEXUS_MASTER_KEY || '',

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
      return new CloudflareService(config.apiKey, config.instanceId);
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

// Initialize services
for (const config of collectProviderKeys()) {
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

    // --- SECURITY: Master Key Authentication ---
    // Skip auth for health check (allows monitoring tools to work)
    if (CONFIG.masterKey && url.pathname !== '/health') {
      const authHeader = req.headers.get('Authorization');
      if (authHeader !== `Bearer ${CONFIG.masterKey}`) {
        return new Response(
          JSON.stringify({
            error: { message: 'Unauthorized: Invalid or missing API key', type: 'authentication_error' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
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
      let hasDecrementedInFlight = false; // Prevent double decrement - declared here for catch scope

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
        const allowedProviders = route.providers;
        const modelAliases = route.modelAliases;
        const configuredProviders = new Set(trackedServices.map(ts => ts.service.provider));
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

              const emitChunk = (service: AIService, content: string) => {
                const data = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created,
                  model: service.name,
                  choices: [{ delta: { content }, index: 0, finish_reason: null }],
                };
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
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