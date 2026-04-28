/**
 * Nexus AI Gateway - Structured logging.
 *
 * `logger` is the root pino instance for operational logs (request handling,
 * routing decisions, circuit breaker transitions, provider errors). All
 * request-scoped log lines should go through `requestLogger(traceId)` so they
 * carry a `trace_id` and can be correlated across the retry loop.
 *
 * `LOG_LEVEL` (info|debug|warn|error|...) wins over the legacy `DEBUG=1`
 * toggle. When neither is set, the logger defaults to `info` in production and
 * `info` everywhere else (set `LOG_LEVEL=debug` for verbose output).
 */

import pino from 'pino';
import type { Logger } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const debugForced = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const level = process.env.LOG_LEVEL || (debugForced ? 'debug' : 'info');

export const logger: Logger = pino({
  level,
  base: { service: 'nexus-gateway' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.api_key',
      '*.apiKey',
      '*.password',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      }
    : undefined,
});

export type RequestLogger = Logger;

export function requestLogger(traceId: string, extra?: Record<string, unknown>): RequestLogger {
  return logger.child({ trace_id: traceId, ...(extra ?? {}) });
}
