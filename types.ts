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
 * OpenAI-compatible tool call structure (emitted by assistant messages).
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Chat message structure (OpenAI-compatible)
 * Supports both simple text and multimodal content, plus tool-use fields.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: MessageContent | null;
  /** Required for role=tool — links result to the assistant's tool_call. */
  tool_call_id?: string;
  /** Present on assistant messages that request tool execution. */
  tool_calls?: ToolCall[];
  /** Required for role=function; optional name for role=tool. */
  name?: string;
}

// --- SERVICE INTERFACE ---

/**
 * Streaming yield event for an upstream tool_call delta.
 * Emitted by services when the provider streams `delta.tool_calls[i]` chunks.
 *
 * Mirrors the OpenAI streaming shape: each chunk may carry partial info
 * (id/name once at the start, then incremental `arguments` string fragments)
 * for a given `index`. The consumer is responsible for accumulating these.
 */
export interface ToolCallDelta {
  type: 'tool_call_delta';
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** Union of values yielded by `AIService.chat()`. */
export type ChatStreamChunk = string | ToolCallDelta;

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
   * @yields Either a string fragment of `delta.content`, or a `ToolCallDelta`
   *         describing an incremental `delta.tool_calls[i]` event.
   */
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatStreamChunk, void, unknown>;

  /**
   * Non-streaming completion for tool calls or JSON responses.
   */
  createChatCompletion?(messages: ChatMessage[], options?: ChatOptions): Promise<unknown>;
}

// --- PROVIDER TYPES ---

export type ProviderType = 'groq' | 'gemini' | 'openrouter' | 'cerebras' | 'cloudflare';

/**
 * Optional chat completion params (OpenAI-compatible subset)
 */
export interface ChatOptions {
  model?: string;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

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
  skipCount: number;
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
  enabled: boolean;
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

// --- GATEWAY TOKEN / AUTH TYPES ---

/**
 * Per-user gateway token row. The `secret` is the full token value as stored
 * in the DB; do not expose it after creation.
 */
export interface GatewayToken {
  id: number;
  label: string;
  secret: string;
  active: number; // 1 = active, 0 = revoked
  monthly_quota_tokens: number | null;
  used_tokens_current_month: number;
  quota_reset_at: string | null;
  created_at: string;
  last_used_at: string | null;
  notes: string | null;
}

/**
 * Authentication context attached to a request after credential verification.
 *  - `master`: validated against `NEXUS_MASTER_KEY`. Unrestricted.
 *  - `token`: validated against a row in `gateway_tokens`. Quota-bound.
 */
export type AuthContext =
  | { type: 'master' }
  | {
      type: 'token';
      tokenId: number;
      label: string;
      monthlyQuota: number | null;
      used: number;
    };