import { z } from 'zod';
import type { ToolDefinition } from '@studentos/llm';
import type { Tool, ToolContext } from './types.js';

/**
 * The set of tools available to an agent run.
 *
 * Deliberately per-run rather than global: which tools an agent gets depends on
 * which Google scopes that student granted, so the set is assembled per
 * request. Registering a Calendar tool for a student who never connected
 * Calendar just wastes context and invites the model to call something that
 * cannot work.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool<never, unknown>>();

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered`);
    }
    this.#tools.set(tool.id, tool as unknown as Tool<never, unknown>);
    return this;
  }

  get(id: string): Tool<never, unknown> | undefined {
    return this.#tools.get(id);
  }

  ids(): string[] {
    return [...this.#tools.keys()];
  }

  /** Provider-neutral definitions to send with a chat request. */
  toDefinitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  /**
   * Parse arguments and run the tool.
   *
   * `rawArguments` is the JSON string the model produced. It is parsed and
   * schema-validated here, so a malformed tool call becomes an error message
   * the model can recover from rather than a thrown exception mid-run.
   */
  async execute(id: string, rawArguments: string, ctx: ToolContext): Promise<unknown> {
    const tool = this.#tools.get(id);
    if (!tool) {
      return { error: `Unknown tool "${id}"` };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawArguments);
    } catch {
      return { error: 'Arguments were not valid JSON' };
    }

    const result = tool.inputSchema.safeParse(parsedJson);
    if (!result.success) {
      return { error: `Invalid arguments: ${result.error.message}` };
    }

    return tool.execute(result.data as never, ctx);
  }
}
