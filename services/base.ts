/**
 * Base class for OpenAI-compatible API services.
 * Eliminates code duplication between Groq, OpenRouter, and Cerebras.
 */

import OpenAI from 'openai';
import type {
    AIService,
    ChatMessage,
    ChatStreamChunk,
    ProviderType,
    ServiceConfig,
    ChatOptions,
    getTextContent
} from '../types';
import { logger } from '../logger';

/**
 * Configuration options for OpenAI-compatible services
 */
export interface OpenAIServiceOptions extends ServiceConfig {
    provider: ProviderType;
    displayName: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
    defaultModel: string;
    modelEnvVar?: string;
    extraCreateParams?: Record<string, unknown>;
}

/**
 * Base class for all OpenAI-compatible AI services.
 * Handles common streaming logic, error handling, and response parsing.
 */
export abstract class BaseOpenAIService implements AIService {
    protected readonly client: OpenAI;
    public readonly name: string;
    public readonly provider: ProviderType;
    protected readonly model: string;
    protected readonly extraParams: Record<string, unknown>;
    public lastStreamUsage: { prompt_tokens: number; completion_tokens: number } | null = null;

    constructor(options: OpenAIServiceOptions) {
        this.provider = options.provider;
        this.name = `${options.displayName} (Key #${options.instanceId})`;

        // Allow model override via environment variable
        this.model = options.modelEnvVar
            ? (process.env[options.modelEnvVar] || options.defaultModel)
            : options.defaultModel;

        this.extraParams = options.extraCreateParams || {};

        this.client = new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
            defaultHeaders: options.defaultHeaders,
        });
    }

    /**
     * Stream chat completion responses.
     * Common implementation for all OpenAI-compatible APIs.
     *
     * Yields either:
     *   - a string (a `delta.content` fragment), or
     *   - a `ToolCallDelta` (one entry from `delta.tool_calls[]`).
     *
     * Consumers MUST be prepared for both shapes; see `ChatStreamChunk` in
     * types.ts. Tool-call deltas are emitted verbatim per chunk (id/name
     * typically only on the first delta for an index, with incremental
     * `arguments` string fragments following) — accumulation is the
     * consumer's responsibility, mirroring how an OpenAI-compatible client
     * would handle the raw upstream stream.
     */
    async *chat(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<ChatStreamChunk, void, unknown> {
        try {
            const { model, ...restOptions } = options;
            const resolvedModel = model || this.model;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const completion = await (this.client.chat.completions.create as any)({
                messages: this.formatMessages(messages),
                model: resolvedModel,
                stream: true,
                ...this.extraParams,
                ...restOptions,
            });

            for await (const chunk of completion) {
                const ch = chunk as any;
                if (ch.usage) {
                    this.lastStreamUsage = {
                        prompt_tokens: ch.usage.prompt_tokens || 0,
                        completion_tokens: ch.usage.completion_tokens || 0,
                    };
                }
                const delta = ch.choices?.[0]?.delta;
                const content = delta?.content;
                if (content) {
                    yield content;
                }
                const toolCalls = delta?.tool_calls;
                if (Array.isArray(toolCalls)) {
                    for (const tc of toolCalls) {
                        if (!tc) continue;
                        const idx = typeof tc.index === 'number' ? tc.index : 0;
                        yield {
                            type: 'tool_call_delta',
                            index: idx,
                            id: tc.id,
                            name: tc.function?.name,
                            arguments: tc.function?.arguments,
                        };
                    }
                }
            }
        } catch (error) {
            logger.error(
                { tag: 'ProviderError', provider_name: this.name, provider: this.provider, err: error as Error },
                `[${this.name}] Error: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
        }
    }

    async createChatCompletion(messages: ChatMessage[], options: ChatOptions = {}): Promise<unknown> {
        try {
            const { model, ...restOptions } = options;
            const resolvedModel = model || this.model;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const completion = await (this.client.chat.completions.create as any)({
                messages: this.formatMessages(messages),
                model: resolvedModel,
                stream: false,
                ...this.extraParams,
                ...restOptions,
            });

            return completion;
        } catch (error) {
            logger.error(
                { tag: 'ProviderError', provider_name: this.name, provider: this.provider, err: error as Error },
                `[${this.name}] Error: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
        }
    }

    /**
     * Format messages for the API.
     * Preserves OpenAI tool-use fields (tool_call_id, tool_calls, name) which
     * are required by providers to match tool results back to invocations.
     * Override in subclasses if special formatting is needed.
     */
    protected formatMessages(
        messages: ChatMessage[]
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return messages.map(msg => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m: any = { role: msg.role };

            // Content: string, multimodal array, or null/undefined
            // (null/undefined is valid for assistant messages with tool_calls).
            if (typeof msg.content === 'string') {
                m.content = msg.content;
            } else if (Array.isArray(msg.content)) {
                m.content = msg.content.map((part: any) => {
                    if (part.type === 'text') {
                        return { type: 'text' as const, text: part.text };
                    }
                    return {
                        type: 'image_url' as const,
                        image_url: part.image_url,
                    };
                });
            } else if (msg.content === null || msg.content === undefined) {
                m.content = msg.content;
            }

            // Preserve tool-use related fields from the OpenAI spec.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyMsg = msg as any;
            if (anyMsg.tool_call_id !== undefined) m.tool_call_id = anyMsg.tool_call_id;
            if (anyMsg.tool_calls !== undefined) m.tool_calls = anyMsg.tool_calls;
            if (anyMsg.name !== undefined) m.name = anyMsg.name;

            return m;
        }) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    }
}
