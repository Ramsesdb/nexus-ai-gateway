/**
 * Nexus AI Gateway - Upstream error classifier.
 *
 * Decides whether an upstream provider failure should be retried (rotated to
 * the next provider in the pool) or surfaced to the client immediately. The
 * retry loop in `index.ts` calls `classifyUpstreamError(...)` after each
 * provider failure and acts on the returned `RetryDecision`.
 *
 * Taxonomy (see README "Error Handling and Retry Classification"):
 *
 *   failFast (return to client, do NOT rotate provider):
 *     - 400, 422, 404            -> INVALID_REQUEST  (client request is the bug)
 *     - 413                      -> INVALID_REQUEST  (payload too large; preserved status)
 *     - 401, 403 from upstream   -> UPSTREAM_ERROR (502, gateway misconfig)
 *
 *   retryable (rotate to next provider):
 *     - 408, 409, 429, 5xx
 *     - network / timeout / first-token-timeout
 */

import type { ErrorCode } from '../errors';

export type RetryDecision =
  | { kind: 'retryable'; reason: string }
  | {
      kind: 'failFast';
      httpStatus: number;
      errorCode: ErrorCode;
      reason: string;
      surfaceMessage: string;
    };

export type UpstreamErrorKind = 'network' | 'timeout' | 'first-token-timeout' | 'http';

export interface ClassifyInput {
  /** Upstream HTTP status, or 0 for network/timeout/first-token-timeout errors. */
  status: number;
  /** Best-effort upstream response body for surfaceMessage extraction. */
  bodyText?: string;
  /** Provider display name for logging context. */
  providerName: string;
  /** Discriminator for non-HTTP errors. Defaults to 'http'. */
  errorKind?: UpstreamErrorKind;
}

const FAILFAST_GENERIC_FALLBACK = 'Provider rejected request';
// 401/403 surface message is generic to avoid leaking gateway API keys or
// upstream auth diagnostics back to callers (the body for these statuses
// frequently echoes the bad header).
const FAILFAST_AUTH_SURFACE = 'Upstream provider authentication failed';

/**
 * Defensive extraction of a clean human-readable error message from an upstream
 * JSON error body. Falls back to a generic string on any parse error or shape
 * mismatch. Length-capped to avoid leaking large diagnostic payloads.
 */
function extractCleanMessage(bodyText: string | undefined): string {
  if (!bodyText || typeof bodyText !== 'string') return FAILFAST_GENERIC_FALLBACK;
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return FAILFAST_GENERIC_FALLBACK;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const root = parsed as Record<string, unknown>;
      const errField = root.error;
      if (typeof errField === 'string' && errField.trim().length > 0) {
        return errField.slice(0, 500);
      }
      if (errField && typeof errField === 'object') {
        const errObj = errField as Record<string, unknown>;
        const msg = errObj.message;
        if (typeof msg === 'string' && msg.trim().length > 0) {
          return msg.slice(0, 500);
        }
      }
      const topMsg = root.message;
      if (typeof topMsg === 'string' && topMsg.trim().length > 0) {
        return topMsg.slice(0, 500);
      }
    }
  } catch {
    /* fall through to generic */
  }
  return FAILFAST_GENERIC_FALLBACK;
}

export function classifyUpstreamError(input: ClassifyInput): RetryDecision {
  const kind = input.errorKind ?? 'http';

  if (kind === 'network') {
    return { kind: 'retryable', reason: 'network error' };
  }
  if (kind === 'timeout') {
    return { kind: 'retryable', reason: 'request timeout' };
  }
  if (kind === 'first-token-timeout') {
    return { kind: 'retryable', reason: 'first-token timeout' };
  }

  const status = input.status;

  if (status === 401 || status === 403) {
    return {
      kind: 'failFast',
      httpStatus: 502,
      errorCode: 'UPSTREAM_ERROR',
      reason: `upstream auth failure (status=${status}, provider=${input.providerName})`,
      surfaceMessage: FAILFAST_AUTH_SURFACE,
    };
  }

  if (status === 400 || status === 422) {
    return {
      kind: 'failFast',
      httpStatus: 400,
      errorCode: 'INVALID_REQUEST',
      reason: `client request rejected by upstream (status=${status})`,
      surfaceMessage: extractCleanMessage(input.bodyText),
    };
  }

  if (status === 413) {
    return {
      kind: 'failFast',
      httpStatus: 413,
      errorCode: 'INVALID_REQUEST',
      reason: 'payload too large',
      surfaceMessage: extractCleanMessage(input.bodyText),
    };
  }

  if (status === 404) {
    return {
      kind: 'failFast',
      httpStatus: 400,
      errorCode: 'INVALID_REQUEST',
      reason: 'upstream returned 404 (likely unknown model)',
      surfaceMessage: extractCleanMessage(input.bodyText),
    };
  }

  if (status === 408) {
    return { kind: 'retryable', reason: 'upstream request timeout (408)' };
  }
  if (status === 409) {
    return { kind: 'retryable', reason: 'upstream conflict (409)' };
  }
  if (status === 429) {
    return { kind: 'retryable', reason: 'upstream rate limited (429)' };
  }
  if (status >= 500 && status <= 599) {
    return { kind: 'retryable', reason: `upstream 5xx (${status})` };
  }

  // Status 0 with kind='http' (or any other unmapped non-2xx): treat as
  // retryable so the loop can try the next provider — defensive default,
  // matches the legacy behavior before classification was introduced.
  return { kind: 'retryable', reason: `unmapped upstream status (${status})` };
}
