/**
 * Cerebras Service - Ultra-fast inference on WSE hardware
 * Model configurable via CEREBRAS_MODEL env var
 * Note: Using OpenAI-compatible API instead of native SDK for consistency
 */

import { BaseOpenAIService } from './base';

export class CerebrasService extends BaseOpenAIService {
  constructor(apiKey: string, instanceId: string = '1') {
    if (!apiKey) {
      throw new Error('Cerebras API key is required');
    }

    super({
      provider: 'cerebras',
      displayName: 'Cerebras',
      apiKey,
      instanceId,
      baseURL: 'https://api.cerebras.ai/v1',
      defaultModel: 'zai-glm-4.7',
      modelEnvVar: 'CEREBRAS_MODEL',
      extraCreateParams: {
        max_completion_tokens: 40960,
        temperature: 0.6,
        top_p: 0.95,
      },
    });
  }
}