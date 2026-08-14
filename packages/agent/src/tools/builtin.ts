import { ToolRegistry } from './registry.js';
import type { ScopeGroup } from './google/scopes.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from './google/calendar.js';
import { listCoursework } from './google/classroom.js';

/**
 * Build the tool set for one student, based on what they have actually
 * connected.
 *
 * Registration is gated on granted scopes rather than registering everything
 * and letting tools report "not connected" at call time. Two reasons:
 *
 *   - every tool definition costs context on every single turn, and a student
 *     with no Google connection should not pay for two they cannot use;
 *   - a model handed a calendar tool will try to use it when asked about
 *     scheduling, burn a turn discovering it is unavailable, and then apologise
 *     -- which reads as the product being broken rather than not set up.
 *
 * The tools still check availability defensively; a scope can be revoked
 * between the registry being built and the tool being called.
 */
export function buildToolRegistry(grantedGroups: ScopeGroup[]): ToolRegistry {
  const registry = new ToolRegistry();
  const granted = new Set(grantedGroups);

  if (granted.has('calendar')) {
    registry.register(listCalendarEvents);
    registry.register(createCalendarEvent);
    registry.register(updateCalendarEvent);
    registry.register(deleteCalendarEvent);
  }

  if (granted.has('classroom')) {
    registry.register(listCoursework);
  }

  return registry;
}
