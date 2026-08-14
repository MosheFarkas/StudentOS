import type { ProviderId } from '@contexto/shared';

/**
 * The seam between the agent core and whoever is actually paying for inference.
 *
 * Call sites depend on this interface and nothing else. Adding a hosted tier, a
 * school-funded tier, or a self-hosted model later means writing one more
 * implementation and one registry rule -- no call site changes. That property
 * is the entire reason this package exists as a package.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  /** Model this provider will use, for logging and usage rows. */
  readonly model: string;

  chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse>;
  stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk>;
}

export interface ProviderContext {
  userId: string;
  agentId?: string;
  /** Aborts the upstream request when the client disconnects. */
  signal?: AbortSignal;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on `role: 'tool'` messages to pair a result with its call. */
  toolCallId?: string;
  /**
   * Set on `role: 'assistant'` messages that requested tools.
   *
   * Both OpenAI and Anthropic require the original tool call to be replayed in
   * the conversation before its result -- otherwise the result refers to
   * nothing and the request is rejected. Dropping these is the classic
   * multi-turn tool-calling bug, and it only shows up once a tool is actually
   * registered, which is exactly when it is hardest to notice.
   */
  toolCalls?: ToolCall[];
}

/**
 * Provider-neutral tool description.
 *
 * JSON Schema rather than a Zod type because this crosses the provider
 * boundary and every vendor speaks JSON Schema. packages/agent converts its
 * Zod schemas to this shape at the edge.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the provider. Always parse -- never string-match. */
  arguments: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prefix tokens served from the provider's cache, billed at a discount. */
  cachedInputTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; usage: TokenUsage; finishReason: ChatResponse['finishReason'] };
