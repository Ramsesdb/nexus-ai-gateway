/**
 * Nexus AI Gateway - Prometheus metrics.
 *
 * Exposed on `GET /metrics` (text/plain; version=0.0.4). When `METRICS_TOKEN`
 * is set in the environment, the endpoint requires `Authorization: Bearer
 * <token>`; otherwise it is open (Prometheus-style assumption that scrapers
 * live on a private network).
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'gateway_requests_total',
  help: 'Total HTTP requests received by the gateway',
  labelNames: ['method', 'path', 'status', 'error_code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'gateway_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const upstreamRequestsTotal = new Counter({
  name: 'gateway_upstream_requests_total',
  help: 'Requests sent to upstream providers',
  // outcome: success | retried | failed
  labelNames: ['provider', 'model', 'status', 'outcome'] as const,
  registers: [registry],
});

export const upstreamFirstTokenMs = new Histogram({
  name: 'gateway_upstream_first_token_ms',
  help: 'Time to first token from upstream provider',
  labelNames: ['provider'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'gateway_circuit_breaker_state',
  help: 'Circuit breaker state per provider (0=closed, 1=open, 2=half-open)',
  labelNames: ['provider'] as const,
  registers: [registry],
});

export const activeStreams = new Gauge({
  name: 'gateway_active_streams',
  help: 'Number of currently active SSE streams',
  registers: [registry],
});

/** Numeric encoding used by `circuitBreakerState`. */
export function circuitStateToNumber(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): number {
  switch (state) {
    case 'CLOSED': return 0;
    case 'OPEN': return 1;
    case 'HALF_OPEN': return 2;
  }
}
