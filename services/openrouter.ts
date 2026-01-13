/**
 * OpenRouter Service - Aggregator for multiple AI models
 * Model configurable via OPENROUTER_MODEL env var
 */

import { BaseOpenAIService } from './base';

export class OpenRouterService extends BaseOpenAIService {
  constructor(apiKey: string, instanceId: string = '1') {
    super({
      provider: 'openrouter',
      displayName: 'OpenRouter',
      apiKey,
      instanceId,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': process.env.OPENROUTER_X_TITLE || 'Nexus AI Gateway',
      },
      defaultModel: 'deepseek/deepseek-r1-0528:free',
      modelEnvVar: 'OPENROUTER_MODEL',
    });
  }
}
