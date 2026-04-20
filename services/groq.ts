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
   * Tool-use fields (tool_call_id, tool_calls, name) MUST be preserved or
   * Groq rejects with "missing tool_call_id".
   */
  protected override formatMessages(
    messages: ChatMessage[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = { role: msg.role };

      // Flatten content to a string (or keep null for assistant+tool_calls).
      if (Array.isArray(msg.content)) {
        m.content = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text as string)
          .join('\n');
      } else if (typeof msg.content === 'string') {
        m.content = msg.content;
      } else if (msg.content === null || msg.content === undefined) {
        m.content = msg.content;
      }

      // Preserve tool-use fields after content flattening.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMsg = msg as any;
      if (anyMsg.tool_call_id !== undefined) m.tool_call_id = anyMsg.tool_call_id;
      if (anyMsg.tool_calls !== undefined) m.tool_calls = anyMsg.tool_calls;
      if (anyMsg.name !== undefined) m.name = anyMsg.name;

      return m as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
  }
}
