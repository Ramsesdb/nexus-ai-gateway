/**
 * Nexus AI Gateway - Stable error code taxonomy.
 *
 * All gateway error responses follow the OpenAI-compatible shape:
 *   { error: { message: string, type: string, code: ErrorCode } }
 *
 * `code` is the machine-readable, stable identifier — clients should branch on
 * it rather than parsing `message` (which is human-readable and may be
 * localized or refined over time).
 *
 * `type` is preserved for backward compatibility with OpenAI SDKs that already
 * read it; the `code` field is additive.
 */

export const ERROR_CODES = [
  'QUOTA_EXCEEDED',
  'CIRCUIT_OPEN',
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'NO_PROVIDER_AVAILABLE',
  'INVALID_REQUEST',
  'UPSTREAM_ERROR',
  'RATE_LIMITED',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export interface ErrorResponseExtras {
  /** Extra fields merged into the `error` object (e.g. `param`, `label`, `quota`). */
  extras?: Record<string, unknown>;
  /** Extra HTTP headers merged into the response (e.g. `Retry-After`). */
  headers?: Record<string, string>;
}

/**
 * Build a JSON error Response in the OpenAI-compatible shape, including the
 * stable `code` field. Always sets `Content-Type: application/json` and merges
 * the per-request CORS headers the caller already computed.
 */
export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  type: string = 'gateway_error',
  corsHeaders: Record<string, string> = {},
  options: ErrorResponseExtras = {},
): Response {
  const errorBody: Record<string, unknown> = { message, type, code };
  if (options.extras) {
    for (const [k, v] of Object.entries(options.extras)) {
      errorBody[k] = v;
    }
  }
  return new Response(
    JSON.stringify({ error: errorBody }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        ...(options.headers ?? {}),
      },
    },
  );
}
