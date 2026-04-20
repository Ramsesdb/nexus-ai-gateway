/**
 * Base class for OpenAI-compatible API services.
 * Eliminates code duplication between Groq, OpenRouter, and Cerebras.
 */

import OpenAI from 'openai';
import type {
    AIService,
    ChatMessage,
    ProviderType,
    ServiceConfig,
    ChatOptions,
    getTextContent
} from '../types';

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
     */
    async *chat(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string, void, unknown> {
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
                const content = (chunk as any).choices[0]?.delta?.content;
                if (content) {
                    yield content;
                }
            }
        } catch (error) {
            console.error(`[${this.name}] Error:`, error);
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
            console.error(`[${this.name}] Error:`, error);
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
