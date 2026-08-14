import OpenAI from 'openai';
import type {
  ChatChunk,
  ChatMessage,
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
 * OpenAI adapter, on the Responses API.
 *
 * Backs both the BYOK path and the platform tier -- same wire protocol, only
 * the key and model differ -- which is why this package has one vendor SDK
 * instead of two.
 *
 * Uses /v1/responses rather than /v1/chat/completions because the reasoning
 * models reject the combination of function tools and reasoning on chat
 * completions:
 *
 *   400 Function tools with reasoning_effort are not supported for
 *       gpt-5.6-luna in /v1/chat/completions.
 *
 * The alternative was reasoning_effort: 'none', which keeps chat completions
 * working but turns off the reasoning an agent doing multi-step tool use most
 * needs. Responses is also where OpenAI is putting new capability.
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
    const { instructions, input } = toResponsesInput(request.messages);

    const response = await this.#client.responses.create(
      {
        model: this.model,
        input,
        ...(instructions ? { instructions } : {}),
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
        // Flat shape on Responses -- name/description/parameters sit at the top
        // level, not nested under `function` as on chat completions.
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function' as const,
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: false,
              })),
            }
          : {}),
      },
      { signal: ctx.signal },
    );

    const toolCalls: ToolCall[] = response.output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        // call_id, not id: call_id is what a function_call_output must echo.
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }));

    const usageDetails = response.usage?.input_tokens_details as
      { cached_tokens?: number } | undefined;

    return {
      content: response.output_text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: usageDetails?.cached_tokens ?? 0,
      },
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop',
    };
  }

  /**
   * Streaming.
   *
   * Deliberately delegates to chat() and emits the finished answer as one
   * chunk. Nothing consumes streaming yet, and shipping a second, untested
   * request path -- with its own tool-call reassembly -- is how the tool-name
   * and reasoning bugs got to production in the first place.
   *
   * TODO(streaming): implement properly with client.responses.stream() when a
   * route actually streams, and test the delta reassembly against a real call.
   */
  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, ctx);
    if (response.content) {
      yield { type: 'text', text: response.content };
    }
    yield { type: 'done', usage: response.usage, finishReason: response.finishReason };
  }
}

/**
 * Convert provider-neutral messages into a Responses API request.
 *
 * Exported for tests: getting this shape wrong produces a 400 that only
 * appears once tools are in play, so it is worth asserting directly rather
 * than discovering in production.
 */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string | undefined;
  input: OpenAI.Responses.ResponseInput;
} {
  const systemParts: string[] = [];
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // Responses takes the system prompt as top-level `instructions`.
      systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      // Replay the calls themselves. Without these, the function_call_output
      // that follows refers to a call the model never sees and is rejected.
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }

    input.push({ role: 'user', content: message.content });
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input,
  };
}
