/**
 * Nexus AI Gateway - Type Definitions
 * Updated for 2026 with multimodal support
 */

// --- CHAT MESSAGE TYPES (OpenAI-compatible with multimodal support) ---

/**
 * Text content part for messages
 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * Image content part for multimodal messages (Llama 4, Gemini 2.5)
 */
export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string; // Base64 data URL or HTTP URL
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * Content can be a simple string or array of content parts (multimodal)
 */
export type MessageContent = string | Array<TextContentPart | ImageContentPart>;

/**
 * Chat message structure (OpenAI-compatible)
 * Supports both simple text and multimodal content
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

// --- SERVICE INTERFACE ---

/**
 * Standard interface that all AI providers must implement.
 * This ensures the Load Balancer can treat all providers the same.
 */
export interface AIService {
  /** Display name for logging, e.g., "Groq (Key #1)" */
  readonly name: string;

  /** Provider identifier for routing logic */
  readonly provider: ProviderType;

  /** 
   * Stream chat completion responses.
   * @param messages - Array of chat messages
   * @yields String chunks of the response
   */
  chat(messages: ChatMessage[]): AsyncGenerator<string, void, unknown>;
}

// --- PROVIDER TYPES ---

export type ProviderType = 'groq' | 'gemini' | 'openrouter' | 'cerebras';

/**
 * Configuration for a service instance
 */
export interface ServiceConfig {
  apiKey: string;
  instanceId: string;
  model?: string;
}

// --- METRICS TYPES ---

/**
 * Metrics tracked for each service instance
 */
export interface ServiceMetrics {
  totalRequests: number;
  successCount: number;
  failCount: number;
  totalLatencyMs: number;
  lastError?: string;
  lastErrorTime?: number;
}

/**
 * Service with associated metrics
 */
export interface TrackedService {
  service: AIService;
  metrics: ServiceMetrics;
}

// --- UTILITY FUNCTIONS ---

/**
 * Extract text content from a message, handling both string and multimodal formats
 */
export function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((part): part is TextContentPart => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/**
 * Check if content contains images
 */
export function hasImageContent(content: MessageContent): boolean {
  if (typeof content === 'string') {
    return false;
  }
  return content.some(part => part.type === 'image_url');
}