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
            const completion = await this.client.chat.completions.create({
                messages: this.formatMessages(messages),
                model: options.model || this.model,
                stream: true,
                ...this.extraParams,
                ...options,
            });

            for await (const chunk of completion) {
                const content = chunk.choices[0]?.delta?.content;
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
            const completion = await this.client.chat.completions.create({
                messages: this.formatMessages(messages),
                model: options.model || this.model,
                stream: false,
                ...this.extraParams,
                ...options,
            });

            return completion;
        } catch (error) {
            console.error(`[${this.name}] Error:`, error);
            throw error;
        }
    }

    /**
     * Format messages for the API.
     * Override in subclasses if special formatting is needed.
     */
    protected formatMessages(
        messages: ChatMessage[]
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return messages.map(msg => ({
            role: msg.role,
            content: typeof msg.content === 'string'
                ? msg.content
                : msg.content.map(part => {
                    if (part.type === 'text') {
                        return { type: 'text' as const, text: part.text };
                    }
                    return {
                        type: 'image_url' as const,
                        image_url: part.image_url,
                    };
                }),
        })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    }
}
