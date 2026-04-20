/**
 * Groq Service - Ultra-fast inference with Llama 4
 * Model configurable via GROQ_MODEL env var
 * Uses OpenAI-compatible API for consistency
 */

import OpenAI from 'openai';
import { BaseOpenAIService } from './base';
import type { ChatMessage } from '../types';

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

  /**
   * Groq only accepts content as a plain string.
   * Flatten array content (OpenAI multipart format) into a single string,
   * discarding image_url parts which Groq does not support.
   */
  protected override formatMessages(
    messages: ChatMessage[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      let content: string;
      if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text as string)
          .join('\n');
      } else {
        content = msg.content;
      }
      return { role: msg.role, content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
  }
}
