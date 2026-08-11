import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderContext,
  ToolCall,
} from '../types.js';

/** Default when a student brings an Anthropic key without naming a model. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

/**
 * Anthropic adapter for the BYOK path.
 *
 * Two shape differences from OpenAI that this class absorbs so call sites never
 * see them: the system prompt is a top-level field rather than a message, and
 * tool results are content blocks inside a user turn rather than their own role.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  readonly #client: Anthropic;

  constructor({ apiKey, model = DEFAULT_ANTHROPIC_MODEL }: AnthropicProviderOptions) {
    this.model = model;
    this.#client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const { system, messages } = splitSystem(request.messages);

    const response = await this.#client.messages.create(
      {
        model: this.model,
        // Caps thinking + visible output together. Opus 5 thinks by default,
        // so a value tuned for a non-thinking model will truncate answers.
        max_tokens: request.maxOutputTokens ?? 16_000,
        system,
        messages,
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters as Anthropic.Tool.InputSchema,
        })),
      },
      { signal: ctx.signal },
    );

    // Safety classifiers can decline with HTTP 200 and empty content. Reading
    // content[0] without this check throws on a refusal.
    if (response.stop_reason === 'refusal') {
      return {
        content: '',
        toolCalls: [],
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        },
        finishReason: 'other',
      };
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls: ToolCall[] = response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      }));

    return {
      content: text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const { system, messages } = splitSystem(request.messages);

    const stream = this.#client.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens ?? 16_000,
        system,
        messages,
      },
      { signal: ctx.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: 'done',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cachedInputTokens: final.usage.cache_read_input_tokens ?? 0,
      },
      finishReason: final.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }
}

/** Anthropic takes the system prompt as a top-level field, not a message. */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m): Anthropic.MessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
        };
      }
      return { role: m.role, content: m.content };
    });

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: rest,
  };
}
