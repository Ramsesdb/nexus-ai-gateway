/**
 * Nexus AI Gateway v1.0 - Production-Ready AI Proxy
 * Features: Health-aware load balancing, Circuit Breaker, Graceful Shutdown
 */

import { GroqService } from './services/groq';
import { GeminiService } from './services/gemini';
import { OpenRouterService } from './services/openrouter';
import { CerebrasService } from './services/cerebras';
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
  // Strategy: Cerebras (fastest) > Groq (reliable) > OpenRouter (free) > Gemini (avoid abuse blocks)
  const providerPriorityOrder: Record<ProviderType, number> = {
    cerebras: 10,  // Best free tier: 1M tokens/day, 2000+ tok/s
    groq: 8,       // Reliable backup: 500+ tok/s
    openrouter: 6, // Free tier backup
    gemini: 2,     // LAST RESORT - can block for abuse from same IP
  };

  const patterns = [
    { provider: 'groq' as ProviderType, prefix: 'GROQ_KEY_', priority: 2 },
    { provider: 'gemini' as ProviderType, prefix: 'GEMINI_KEY_', priority: 2 },
    { provider: 'openrouter' as ProviderType, prefix: 'OPENROUTER_KEY_', priority: 2 },
    { provider: 'cerebras' as ProviderType, prefix: 'CEREBRAS_KEY_', priority: 2 },
    { provider: 'groq' as ProviderType, prefix: 'GROQ_API_KEY_', priority: 1 },
    { provider: 'gemini' as ProviderType, prefix: 'GEMINI_API_KEY_', priority: 1 },
    { provider: 'openrouter' as ProviderType, prefix: 'OPENROUTER_API_KEY_', priority: 1 },
    { provider: 'cerebras' as ProviderType, prefix: 'CEREBRAS_API_KEY_', priority: 1 },
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
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
};

const createInitialMetrics = (): ServiceMetrics => ({
  totalRequests: 0,
  successCount: 0,
  failCount: 0,
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

// --- 7. HEALTH-AWARE LOAD BALANCER ---

const calculateHealthScore = (tracked: EnhancedTrackedService): number => {
  const { metrics, circuitBreaker: cb, service } = tracked;

  // Circuit breaker penalty
  if (cb.state === 'OPEN') return 0;
  if (cb.state === 'HALF_OPEN') return 0.1;

  // Provider priority bonus (ensures preferred providers are selected when scores are similar)
  const priorityBonus: Record<ProviderType, number> = {
    cerebras: 0.15,   // Highest priority: fastest, best free tier
    groq: 0.10,       // Second priority: reliable
    openrouter: 0.05, // Third priority: free backup
    gemini: 0.00,     // Last resort: can block for abuse
  };
  const providerName = service.name.toLowerCase();
  const bonus = providerName.includes('cerebras') ? priorityBonus.cerebras :
    providerName.includes('groq') ? priorityBonus.groq :
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
 * Select next available service, respecting circuit breaker state and enabled status
 */
const getNextService = (
  excludeIndices: Set<number>,
  routingMode: 'smart' | 'fastest' | 'round-robin' = 'smart'
): EnhancedTrackedService | null => {
  const available = trackedServices
    .map((ts, index) => ({ ts, index }))
    .filter(({ ts, index }) => !excludeIndices.has(index) && ts.enabled && isServiceAvailable(ts)); // Filter out disabled services

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
  const validRoles = ['system', 'user', 'assistant'];

  if (!validRoles.includes(msg.role as string)) return false;

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
          const latency = ts.metrics.totalLatencyMs || 0;
          return {
            name: ts.service.name,
            provider: ts.service.provider,
            circuitState: ts.circuitBreaker.state,
            metrics: {
              totalRequests: total,
              successCount: success,
              failCount: fail,
              successRate: total > 0 ? `${((success / total) * 100).toFixed(1)}%` : 'N/A',
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
        data: trackedServices.map(ts => ({
          id: ts.service.name,
          object: 'model',
          owned_by: ts.service.provider,
          available: ts.enabled && isServiceAvailable(ts),
        })),
      };

      return new Response(JSON.stringify(models), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Chat Completions
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      inFlightRequests++;
      let hasDecrementedInFlight = false; // Prevent double decrement - declared here for catch scope

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

        if (!Array.isArray(messages) || !messages.every(isValidMessage)) {
          inFlightRequests--;
          hasDecrementedInFlight = true;
          return new Response(
            JSON.stringify({ error: { message: 'Invalid messages format', type: 'invalid_request_error' } }),
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

        const decrementInFlight = () => {
          if (!hasDecrementedInFlight) {
            hasDecrementedInFlight = true;
            inFlightRequests--;
          }
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

        if (!streamRequested) {
          const triedIndices = new Set<number>();
          let attemptNumber = 0;

          while (triedIndices.size < trackedServices.length) {
            const tracked = getNextService(triedIndices, routingMode);
            if (!tracked) break;

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

            try {
              const completion = service.createChatCompletion
                ? await service.createChatCompletion(typedMessages, chatOptions)
                : await (async () => {
                    // Fallback to streaming if provider lacks non-streaming
                    let full = '';
                    for await (const chunk of service.chat(typedMessages, chatOptions)) {
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
              tracked.metrics.failCount++;
              tracked.metrics.lastError = errorMsg;
              tracked.metrics.lastErrorTime = Date.now();
              tracked.metrics.totalLatencyMs += Date.now() - startTime;
              recordFailure(tracked);
            }
          }

          return new Response(
            JSON.stringify({ error: { message: 'All providers failed or circuits are open', type: 'gateway_error' } }),
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
                const tracked = getNextService(triedIndices, routingMode);
                if (!tracked) {
                  // All circuits might be open - wait and check again
                  if (attemptNumber > 0) {
                    const backoffDelay = calculateBackoffDelay(attemptNumber);
                    console.log(`[Router] All available circuits tried. Waiting ${backoffDelay}ms before checking again...`);
                    await sleep(backoffDelay);

                    // Check if any circuit has reopened
                    const reopened = trackedServices.some((ts, idx) =>
                      !triedIndices.has(idx) && isServiceAvailable(ts)
                    );
                    if (!reopened) break;
                    continue;
                  }
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

                // Track half-open attempts
                if (tracked.circuitBreaker.state === 'HALF_OPEN') {
                  tracked.circuitBreaker.halfOpenAttempts++;
                }

                console.log(`[Router] Attempt ${attemptNumber}/${trackedServices.length} -> ${service.name} [${tracked.circuitBreaker.state}] mode=${routingMode}`);
                tracked.metrics.totalRequests++;

                try {
                  const gen = service.chat(typedMessages, chatOptions);

                  // First-token timeout
                  const firstResult = await (async () => {
                    if (started || CONFIG.firstTokenTimeoutMs <= 0) {
                      return gen.next();
                    }

                    let timeoutId: ReturnType<typeof setTimeout> | undefined;
                    try {
                      const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(
                          () => reject(new Error(`First token timeout after ${CONFIG.firstTokenTimeoutMs}ms`)),
                          CONFIG.firstTokenTimeoutMs
                        );
                      });
                      return Promise.race([gen.next(), timeoutPromise]);
                    } finally {
                      if (timeoutId) clearTimeout(timeoutId);
                    }
                  })();

                  const emitMetadata = (service: AIService, latency: number, circuitState: string, health: number) => {
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
                  console.error(`[Provider Error] ${service.name}:`, errorMsg);

                  tracked.metrics.failCount++;
                  tracked.metrics.lastError = errorMsg;
                  tracked.metrics.lastErrorTime = Date.now();
                  tracked.metrics.totalLatencyMs += Date.now() - startTime;
                  recordFailure(tracked);

                  if (started) break;
                }
              }

              if (!started && !aborted) {
                emitError('All providers failed or circuits are open');
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
        return new Response(
          JSON.stringify({ error: { message: 'Internal Error', type: 'internal_error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
});

// Register shutdown handlers (after server is created)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));