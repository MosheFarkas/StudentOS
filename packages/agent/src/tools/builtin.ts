import { ToolRegistry } from './registry.js';
import { SCOPE_GROUPS, hasScope, parseGrantedScopes, type ScopeGroup } from './google/scopes.js';
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
import {
  listMailLabels,
  modifyMail,
  readMail,
  readMailAttachment,
  searchMail,
  sendMail,
  trashMail,
} from './google/gmail.js';
import { readSchoolPortal } from './portal.js';
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
  searchMail,
  readMail,
  readMailAttachment,
  listMailLabels,
  sendMail,
  modifyMail,
  trashMail,
  readWebLink,
  readYoutubeVideo,
  readSchoolPortal,
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
/**
 * An integration, or just the write half of one.
 *
 * 'gmail' switches everything Gmail off; 'gmail:write' leaves reading alone
 * and removes only sending and tidying. That split is what lets a student
 * keep the useful half of an integration without the half they are wary of.
 */
export type IntegrationKey = ScopeGroup | `${ScopeGroup}:write`;

export function buildToolRegistry(
  grantedScope: string | null | undefined,
  disabled: readonly IntegrationKey[] = [],
): ToolRegistry {
  const granted = parseGrantedScopes(grantedScope);
  const registry = new ToolRegistry();

  /*
   * A switched-off integration is treated exactly like one that was never
   * granted: its tools are not registered at all. Registering them and
   * refusing at call time would burn a turn and read to the student as the
   * product being broken rather than as their own setting.
   */
  const off = new Set(
    disabled.flatMap((key) => {
      const [name, part] = key.split(':') as [ScopeGroup, string | undefined];
      const definition = SCOPE_GROUPS[name];
      if (!definition) return [];

      // ':write' removes only the elective scopes, leaving reading intact.
      if (part === 'write') return [...(definition.elective ?? [])];
      return [...definition.required, ...definition.optional, ...(definition.elective ?? [])];
    }),
  );

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
    if (required.some((scope) => off.has(scope))) continue;
    if (required.length === 0 || required.every((scope) => hasScope(scope, granted))) {
      registry.register(tool);
    }
  }

  return registry;
}
