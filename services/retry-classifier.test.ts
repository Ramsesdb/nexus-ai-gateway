import { describe, test, expect } from 'bun:test';
import { classifyUpstreamError } from './retry-classifier';

const PROVIDER = 'TestProvider (Key #1)';

describe('retry-classifier', () => {
  describe('failFast: client-side errors', () => {
    test('400 -> failFast INVALID_REQUEST status 400', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '{"error":{"message":"messages must be array"}}',
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(400);
      expect(decision.errorCode).toBe('INVALID_REQUEST');
      expect(decision.surfaceMessage).toBe('messages must be array');
    });

    test('422 -> failFast INVALID_REQUEST mapped to status 400', () => {
      const decision = classifyUpstreamError({
        status: 422,
        bodyText: '{"error":{"message":"unprocessable"}}',
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(400);
      expect(decision.errorCode).toBe('INVALID_REQUEST');
    });

    test('413 -> failFast INVALID_REQUEST status preserved as 413', () => {
      const decision = classifyUpstreamError({
        status: 413,
        bodyText: '{"error":{"message":"payload too large"}}',
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(413);
      expect(decision.errorCode).toBe('INVALID_REQUEST');
      expect(decision.surfaceMessage).toBe('payload too large');
    });

    test('404 -> failFast INVALID_REQUEST status 400', () => {
      const decision = classifyUpstreamError({
        status: 404,
        bodyText: '{"error":{"message":"model not found"}}',
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(400);
      expect(decision.errorCode).toBe('INVALID_REQUEST');
    });
  });

  describe('failFast: upstream auth errors', () => {
    test('401 -> failFast UPSTREAM_ERROR status 502 with generic message', () => {
      const sensitiveBody = '{"error":{"message":"Invalid API key sk-bigwise-leaked-1234"}}';
      const decision = classifyUpstreamError({
        status: 401,
        bodyText: sensitiveBody,
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(502);
      expect(decision.errorCode).toBe('UPSTREAM_ERROR');
      expect(decision.surfaceMessage).toBe('Upstream provider authentication failed');
      expect(decision.surfaceMessage).not.toContain('sk-bigwise-leaked-1234');
      expect(decision.surfaceMessage).not.toContain('Invalid API key');
    });

    test('403 -> failFast UPSTREAM_ERROR status 502 with generic message', () => {
      const decision = classifyUpstreamError({
        status: 403,
        bodyText: 'Forbidden: token sk-secret-abc',
        providerName: PROVIDER,
      });
      expect(decision.kind).toBe('failFast');
      if (decision.kind !== 'failFast') return;
      expect(decision.httpStatus).toBe(502);
      expect(decision.errorCode).toBe('UPSTREAM_ERROR');
      expect(decision.surfaceMessage).toBe('Upstream provider authentication failed');
      expect(decision.surfaceMessage).not.toContain('sk-secret-abc');
    });
  });

  describe('retryable: transient HTTP errors', () => {
    test('408 request timeout -> retryable', () => {
      const decision = classifyUpstreamError({ status: 408, providerName: PROVIDER });
      expect(decision.kind).toBe('retryable');
    });

    test('429 rate limit -> retryable', () => {
      const decision = classifyUpstreamError({ status: 429, providerName: PROVIDER });
      expect(decision.kind).toBe('retryable');
    });

    test('5xx (500, 502, 503, 504) -> retryable', () => {
      for (const status of [500, 502, 503, 504]) {
        const decision = classifyUpstreamError({ status, providerName: PROVIDER });
        expect(decision.kind).toBe('retryable');
      }
    });
  });

  describe('retryable: non-HTTP errors', () => {
    test('network error -> retryable', () => {
      const decision = classifyUpstreamError({
        status: 0,
        providerName: PROVIDER,
        errorKind: 'network',
      });
      expect(decision.kind).toBe('retryable');
    });

    test('timeout -> retryable', () => {
      const decision = classifyUpstreamError({
        status: 0,
        providerName: PROVIDER,
        errorKind: 'timeout',
      });
      expect(decision.kind).toBe('retryable');
    });

    test('first-token-timeout -> retryable', () => {
      const decision = classifyUpstreamError({
        status: 0,
        providerName: PROVIDER,
        errorKind: 'first-token-timeout',
      });
      expect(decision.kind).toBe('retryable');
      if (decision.kind !== 'retryable') return;
      expect(decision.reason).toContain('first-token');
    });
  });

  describe('body extraction (surfaceMessage)', () => {
    test('valid JSON {error:{message:...}} -> message extracted', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '{"error":{"message":"bad model"}}',
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('bad model');
    });

    test('invalid JSON -> generic fallback', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '<html>Bad Request</html>',
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('Provider rejected request');
    });

    test('empty body -> generic fallback', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '',
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('Provider rejected request');
    });

    test('undefined body -> generic fallback', () => {
      const decision = classifyUpstreamError({
        status: 400,
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('Provider rejected request');
    });

    test('JSON with top-level message field -> extracted', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '{"message":"top level msg"}',
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('top level msg');
    });

    test('JSON with error as string -> extracted', () => {
      const decision = classifyUpstreamError({
        status: 400,
        bodyText: '{"error":"plain error string"}',
        providerName: PROVIDER,
      });
      if (decision.kind !== 'failFast') throw new Error('expected failFast');
      expect(decision.surfaceMessage).toBe('plain error string');
    });
  });
});
