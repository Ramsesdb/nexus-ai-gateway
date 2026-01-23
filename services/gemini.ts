/**
 * Gemini Service - Google's thinking model with enhanced reasoning
 * Model configurable via GEMINI_MODEL env var
 */

import { GoogleGenerativeAI, type GenerativeModel, type Content } from '@google/generative-ai';
import type { AIService, ChatMessage, ProviderType, MessageContent, ChatOptions, getTextContent } from '../types';

export class GeminiService implements AIService {
    private readonly model: GenerativeModel;
    public readonly name: string;
    public readonly provider: ProviderType = 'gemini';

    constructor(apiKey: string, instanceId: string = '1') {
        if (!apiKey) {
            throw new Error('Gemini API key is required');
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

        this.model = genAI.getGenerativeModel({ model: modelName });
        this.name = `Gemini (Key #${instanceId})`;
    }

    async *chat(messages: ChatMessage[], _options: ChatOptions = {}): AsyncGenerator<string, void, unknown> {
        try {
            if (!messages || messages.length === 0) {
                throw new Error('Missing messages');
            }

            // Extract system prompt
            const systemPrompt = messages
                .filter(m => m.role === 'system')
                .map(m => this.extractText(m.content))
                .join('\n')
                .trim();

            // Get non-system messages
            const nonSystemMessages = messages.filter(m => m.role !== 'system');
            if (nonSystemMessages.length === 0) {
                throw new Error('Missing non-system messages');
            }

            // Convert to Gemini format
            const history: Content[] = nonSystemMessages.slice(0, -1).map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: this.convertToParts(m.content),
            }));

            // Prepare last message with system prompt
            const lastMsg = nonSystemMessages[nonSystemMessages.length - 1];
            if (!lastMsg) {
                throw new Error('Missing last message');
            }

            const lastContent = this.extractText(lastMsg.content);
            const lastMessage = systemPrompt
                ? `System instructions:\n${systemPrompt}\n\n${lastContent}`
                : lastContent;

            // Stream response
            const chat = this.model.startChat({ history });
            const result = await chat.sendMessageStream(lastMessage);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) {
                    yield text;
                }
            }
        } catch (error) {
            console.error(`[${this.name}] Error:`, error);
            throw error;
        }
    }

    async createChatCompletion(messages: ChatMessage[], options: ChatOptions = {}): Promise<unknown> {
        try {
            if (!messages || messages.length === 0) {
                throw new Error('Missing messages');
            }

            const systemPrompt = messages
                .filter(m => m.role === 'system')
                .map(m => this.extractText(m.content))
                .join('\n')
                .trim();

            const nonSystemMessages = messages.filter(m => m.role !== 'system');
            if (nonSystemMessages.length === 0) {
                throw new Error('Missing non-system messages');
            }

            const history: Content[] = nonSystemMessages.slice(0, -1).map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: this.convertToParts(m.content),
            }));

            const lastMsg = nonSystemMessages[nonSystemMessages.length - 1];
            if (!lastMsg) {
                throw new Error('Missing last message');
            }

            const lastContent = this.extractText(lastMsg.content);
            const lastMessage = systemPrompt
                ? `System instructions:\n${systemPrompt}\n\n${lastContent}`
                : lastContent;

            const chat = this.model.startChat({ history });

            const toolConfig = options.tools
                ? { toolConfig: { functionDeclarations: options.tools } }
                : undefined;

            const result = await chat.sendMessage(lastMessage, toolConfig as never);
            return result;
        } catch (error) {
            console.error(`[${this.name}] Error:`, error);
            throw error;
        }
    }

    /**
     * Extract text from message content (handles both string and multimodal)
     */
    private extractText(content: MessageContent): string {
        if (typeof content === 'string') {
            return content;
        }
        return content
            .filter(part => part.type === 'text')
            .map(part => (part as { type: 'text'; text: string }).text)
            .join('\n');
    }

    /**
     * Convert message content to Gemini Parts format
     */
    private convertToParts(content: MessageContent): Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> {
        if (typeof content === 'string') {
            return [{ text: content }];
        }

        return content.map(part => {
            if (part.type === 'text') {
                return { text: part.text };
            }

            // Convert image URL to inline data for Gemini
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
                // Extract base64 data from data URL
                const matches = url.match(/^data:(.+);base64,(.+)$/);
                if (matches) {
                    return {
                        inlineData: {
                            mimeType: matches[1]!,
                            data: matches[2]!,
                        },
                    };
                }
            }

            // For HTTP URLs, Gemini requires conversion - for now, just use text description
            return { text: `[Image: ${url}]` };
        });
    }
}
