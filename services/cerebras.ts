/**
 * Cerebras Service - Ultra-fast inference on WSE hardware
 * Model configurable via CEREBRAS_MODEL env var
 * Note: Using OpenAI-compatible API instead of native SDK for consistency
 */

import OpenAI from 'openai';
import { BaseOpenAIService } from './base';
import type { ChatMessage, ChatOptions } from '../types';

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

  /**
   * Cerebras's OpenAI-compatible API is strict about a few things that the
   * base class does not normalize:
   *   1. Message `content` must be a plain string. The multimodal array form
   *      ({type:'text',text:'...'}) triggers a 400 with no body.
   *   2. Tool-use fields (tool_call_id, tool_calls, name) must survive the
   *      content flattening — same rule as Groq.
   *
   * Mirrors the Groq override; diverges only where Cerebras-specific behavior
   * would need to.
   */
  protected override formatMessages(
    messages: ChatMessage[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = { role: msg.role };

      if (Array.isArray(msg.content)) {
        m.content = msg.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((c: any) => c.type === 'text')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => c.text as string)
          .join('\n');
      } else if (typeof msg.content === 'string') {
        m.content = msg.content;
      } else if (msg.content === null || msg.content === undefined) {
        m.content = msg.content;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMsg = msg as any;
      if (anyMsg.tool_call_id !== undefined) m.tool_call_id = anyMsg.tool_call_id;
      if (anyMsg.tool_calls !== undefined) m.tool_calls = anyMsg.tool_calls;
      if (anyMsg.name !== undefined) m.name = anyMsg.name;

      return m as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
  }

  /**
   * Cerebras rejects requests that specify BOTH `max_tokens` and
   * `max_completion_tokens` — this is the common path through the gateway,
   * since callers send `max_tokens` (per OpenAI classic) and this service
   * injects `max_completion_tokens` via extraCreateParams.
   *
   * Normalize to a single `max_completion_tokens` and drop `max_tokens`
   * before it reaches the base class (whose chat/createChatCompletion spread
   * extraParams + options verbatim).
   *
   * Also drops unsupported sampling fields that Cerebras 400s on when passed
   * with defined values (presence_penalty / frequency_penalty are not
   * accepted on most Cerebras-hosted models).
   */
  private sanitizeOptions(options: ChatOptions = {}): ChatOptions {
    const sanitized: ChatOptions = { ...options };

    // Collapse max_tokens -> max_completion_tokens. If caller supplied
    // max_tokens, honor their cap (it's tighter than our default) and
    // drop the legacy field so Cerebras doesn't see both.
    if (sanitized.max_tokens !== undefined) {
      sanitized.max_completion_tokens = sanitized.max_tokens;
      delete sanitized.max_tokens;
    }

    // Cerebras does not support these on current models; sending them
    // (even with small values) triggers "Unsupported parameter" 400s.
    if (sanitized.presence_penalty !== undefined) {
      delete sanitized.presence_penalty;
    }
    if (sanitized.frequency_penalty !== undefined) {
      delete sanitized.frequency_penalty;
    }

    return sanitized;
  }

  override async *chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    yield* super.chat(messages, this.sanitizeOptions(options));
  }

  override async createChatCompletion(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<unknown> {
    return super.createChatCompletion(messages, this.sanitizeOptions(options));
  }
}
