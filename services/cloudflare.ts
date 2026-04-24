/**
 * Cloudflare Workers AI Service - OpenAI-compatible gateway to Cloudflare's hosted models
 * Model configurable via CLOUDFLARE_MODEL env var (default: @cf/meta/llama-3.1-8b-instruct)
 *
 * Notes:
 *  - baseURL is account-scoped: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
 *    The accountId is passed in per-instance so multiple Cloudflare accounts can be used in
 *    parallel (Cloudflare's 10K neurons/day limit is per-account, so additional accounts
 *    multiply capacity). Pairing is done at the factory level in index.ts via
 *    CLOUDFLARE_ACCOUNT_ID_N + CLOUDFLARE_KEY_N.
 *  - Confirmed OpenAI-compatible (chat/completions with model/messages/max_tokens/temperature/stream);
 *    no overrides needed over BaseOpenAIService at this time.
 *  - Model ids keep the mandatory `@cf/` prefix (e.g. `@cf/meta/llama-3.1-8b-instruct`).
 */

import { BaseOpenAIService } from './base';

export class CloudflareService extends BaseOpenAIService {
  constructor(apiKey: string, accountId: string, instanceId: string = '1') {
    if (!apiKey) {
      throw new Error('Cloudflare API key is required');
    }

    if (!accountId) {
      throw new Error(
        'Cloudflare account ID is required. ' +
        'Set CLOUDFLARE_ACCOUNT_ID_N (paired with CLOUDFLARE_KEY_N) or the legacy ' +
        'shared CLOUDFLARE_ACCOUNT_ID fallback.'
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
