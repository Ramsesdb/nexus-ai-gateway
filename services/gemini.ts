/**
 * Gemini Service - Google models via OpenAI-compatible endpoint.
 * Uses the OpenAI SDK pointed at Google's generativelanguage endpoint.
 * Model configurable via GEMINI_MODEL env var.
 *
 * NOTE: Google's OpenAI-compat layer has a known bug with streaming + tools
 * (tool_calls deltas are malformed / dropped). The `chat()` override below
 * falls back to a non-streaming call and re-emits the result as a synthetic
 * single-chunk stream whenever tools are present.
 */

import OpenAI from 'openai';
import { BaseOpenAIService } from './base';
import type { ChatMessage, ChatOptions, ChatStreamChunk } from '../types';

export class GeminiService extends BaseOpenAIService {
  constructor(apiKey: string, instanceId: string = '1') {
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }

    super({
      provider: 'gemini',
      displayName: 'Gemini',
      apiKey,
      instanceId,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      defaultModel: 'gemini-2.5-flash',
      modelEnvVar: 'GEMINI_MODEL',
    });
  }

  /**
   * Gemini's OpenAI-compat endpoint mishandles streaming when tools are
   * provided. When tools are requested, perform a non-streaming call and
   * re-emit as a synthetic stream (single content chunk, then a finish chunk).
   * Otherwise, delegate to the base streaming implementation.
   */
  override async *chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const hasTools = Array.isArray(options.tools) && (options.tools as unknown[]).length > 0;

    if (!hasTools) {
      yield* super.chat(messages, options);
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const completion = (await this.createChatCompletion(messages, options)) as any;
      const choice = completion?.choices?.[0];
      const content: string | undefined = choice?.message?.content;
      if (content) {
        yield content;
      }
      // Re-emit tool_calls from the non-streaming response as synthetic
      // deltas so the gateway's stream consumer can record what the model
      // wanted to invoke (response_preview, etc.). One delta per tool_call
      // carrying the full id/name/arguments — equivalent to a single-chunk
      // upstream stream.
      const toolCalls = choice?.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          if (!tc) continue;
          yield {
            type: 'tool_call_delta',
            index: typeof tc.index === 'number' ? tc.index : i,
            id: tc.id,
            name: tc.function?.name,
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : tc.function?.arguments !== undefined
                ? JSON.stringify(tc.function.arguments)
                : undefined,
          };
        }
      }
    } catch (error) {
      console.error(`[${this.name}] Error:`, error);
      throw error;
    }
  }

  /**
   * Gemini accepts OpenAI-style multimodal content (text + image_url parts)
   * on the compat endpoint, so the default formatter from BaseOpenAIService
   * is sufficient. Override left as hook point in case Google diverges later.
   */
  protected override formatMessages(
    messages: ChatMessage[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return super.formatMessages(messages);
  }
}
