/**
 * Cloudflare Workers AI Service - OpenAI-compatible gateway to Cloudflare's hosted models
 * Model configurable via CLOUDFLARE_MODEL env var (default: @cf/meta/llama-3.1-8b-instruct)
 *
 * Notes:
 *  - baseURL is account-scoped: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
 *    The account ID comes from CLOUDFLARE_ACCOUNT_ID (shared across every CLOUDFLARE_KEY_N
 *    for the same account; Cloudflare's 10K neurons/day limit is per-account, not per-token).
 *  - Confirmed OpenAI-compatible (chat/completions with model/messages/max_tokens/temperature/stream);
 *    no overrides needed over BaseOpenAIService at this time.
 *  - Model ids keep the mandatory `@cf/` prefix (e.g. `@cf/meta/llama-3.1-8b-instruct`).
 */

import { BaseOpenAIService } from './base';

export class CloudflareService extends BaseOpenAIService {
  constructor(apiKey: string, instanceId: string = '1') {
    if (!apiKey) {
      throw new Error('Cloudflare API key is required');
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID is required when Cloudflare keys are configured. ' +
        'Set CLOUDFLARE_ACCOUNT_ID in your environment.'
      );
    }

    super({
      provider: 'cloudflare',
      displayName: 'Cloudflare',
      apiKey,
      instanceId,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      defaultModel: '@cf/meta/llama-3.1-8b-instruct',
      modelEnvVar: 'CLOUDFLARE_MODEL',
    });
  }
}
