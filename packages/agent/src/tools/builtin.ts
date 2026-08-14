import { ToolRegistry } from './registry.js';
import { hasScope, parseGrantedScopes } from './google/scopes.js';
import type { Tool } from './types.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from './google/calendar.js';
import { listCourses, listCoursework } from './google/classroom.js';

const ALL_TOOLS: Tool<never, unknown>[] = [
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listCourses,
  listCoursework,
] as unknown as Tool<never, unknown>[];

/**
 * Build the tool set for one student, from the scopes they actually granted.
 *
 * Per-tool rather than per-group, because school admins grant scope subsets
 * routinely. A student whose admin approved course listing but not coursework
 * should get the course tool and simply not have the other -- not a dead
 * integration, and not a tool that 403s every time the model reaches for it.
 *
 * Two reasons this gating matters beyond correctness: every tool definition
 * costs context on every single turn, and a model handed a tool it cannot use
 * will call it, waste a turn discovering that, and apologise -- which reads as
 * the product being broken rather than not fully approved.
 *
 * Tools still check availability defensively; a scope can be revoked between
 * the registry being built and the tool being called.
 */
export function buildToolRegistry(grantedScope: string | null | undefined): ToolRegistry {
  const granted = parseGrantedScopes(grantedScope);
  const registry = new ToolRegistry();

  for (const tool of ALL_TOOLS) {
    const required = tool.requiredScopes ?? [];
    if (required.length > 0 && required.every((scope) => hasScope(scope, granted))) {
      registry.register(tool);
    }
  }

  return registry;
}
