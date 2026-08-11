import OpenAI from 'openai';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderContext,
  ToolCall,
} from '../types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** 'openai' for a student's own key, 'platform' for ours. */
  id?: 'openai' | 'platform';
}

/**
 * OpenAI adapter.
 *
 * Backs both the BYOK path and the platform tier -- same wire protocol, only
 * the key and model differ -- which is why this package has one vendor SDK
 * instead of two.
 *
 * TODO: this uses chat.completions. OpenAI's Responses API is the newer
 * surface and is where reasoning-model features land first; move when you need
 * something it exposes that this does not.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id: 'openai' | 'platform';
  readonly model: string;
  readonly #client: OpenAI;

  constructor({ apiKey, model, id = 'openai' }: OpenAiProviderOptions) {
    this.id = id;
    this.model = model;
    this.#client = new OpenAI({ apiKey });
  }

  async chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const completion = await this.#client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAiMessages(request),
        tools: request.tools?.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        max_completion_tokens: request.maxOutputTokens,
      },
      { signal: ctx.signal },
    );

    const choice = completion.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no choices');
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((call) =>
      call.type === 'function'
        ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }]
        : [],
    );

    return {
      content: choice.message.content ?? '',
      toolCalls,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason: mapFinishReason(choice.finish_reason),
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const stream = await this.#client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAiMessages(request),
        tools: request.tools?.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        max_completion_tokens: request.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: ctx.signal },
    );

    let finishReason: ChatResponse['finishReason'] = 'other';
    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) {
        finishReason = mapFinishReason(reason);
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
    }

    // TODO(streaming): accumulate tool_calls deltas. They arrive fragmented
    // across chunks and have to be reassembled by index before they are valid
    // JSON -- non-streaming chat() handles tool calls correctly today.
    yield { type: 'done', usage, finishReason };
  }
}

function toOpenAiMessages(request: ChatRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  return request.messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool' as const,
        content: message.content,
        tool_call_id: message.toolCallId ?? '',
      };
    }
    return { role: message.role, content: message.content };
  });
}

function mapFinishReason(reason: string | null | undefined): ChatResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}
