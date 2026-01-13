/**
 * Groq Service - Ultra-fast inference with Llama 4
 * Model configurable via GROQ_MODEL env var
 * Uses OpenAI-compatible API for consistency
 */

import { BaseOpenAIService } from './base';

export class GroqService extends BaseOpenAIService {
  constructor(apiKey: string, instanceId: string = '1') {
    if (!apiKey) {
      throw new Error('Groq API key is required');
    }

    super({
      provider: 'groq',
      displayName: 'Groq',
      apiKey,
      instanceId,
      baseURL: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-4-scout-17b-16e-instruct',
      modelEnvVar: 'GROQ_MODEL',
    });
  }
}
