import { ToolRegistry } from './registry.js';
import { hasScope, parseGrantedScopes } from './google/scopes.js';
import type { Tool } from './types.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from './google/calendar.js';
import {
  attachToSubmission,
  listAnnouncements,
  listCourseMaterials,
  listCourses,
  listCoursework,
  listSubmissions,
  listTopics,
  turnInAssignment,
  unsubmitAssignment,
} from './google/classroom.js';
import { listDriveFiles, readDriveFile } from './google/drive.js';
import { readWebLink } from './web/read-link.js';
import { readYoutubeVideo } from './web/youtube.js';

const ALL_TOOLS: Tool<never, unknown>[] = [
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listCourses,
  listCoursework,
  listCourseMaterials,
  listAnnouncements,
  listSubmissions,
  listTopics,
  turnInAssignment,
  unsubmitAssignment,
  attachToSubmission,
  listDriveFiles,
  readDriveFile,
  readWebLink,
  readYoutubeVideo,
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

    /*
     * No declared scopes means the tool touches no Google data and is always
     * available -- web_read_link is the first of these.
     *
     * The risk in this branch is a Google tool that simply FORGOT to declare
     * its scopes: it would register for everyone and fail at call time. That
     * is caught by a test asserting every google_* tool declares them, rather
     * than by refusing scope-free tools here, which only hid the mistake.
     */
    if (required.length === 0 || required.every((scope) => hasScope(scope, granted))) {
      registry.register(tool);
    }
  }

  return registry;
}
