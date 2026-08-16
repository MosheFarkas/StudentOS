/**
 * Agent core: persistent memory, accumulated skills, tool calling.
 *
 * Structure and storage are real; the learning loop and the Google
 * integrations are deliberately not. See the TODO blocks in
 * skills/registry.ts, memory/summarize.ts, and tools/google/scopes.ts.
 */

export * from './memory/types.js';
export { PostgresMemoryStore } from './memory/store.js';
export {
  summarizeAgentMemory,
  type SummarizeOptions,
  type SummarizerDeps,
} from './memory/summarize.js';

export * from './skills/types.js';
export { PostgresSkillRegistry } from './skills/registry.js';

export * from './tools/types.js';
export { ToolRegistry } from './tools/registry.js';
export { buildToolRegistry } from './tools/builtin.js';
export {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  type CalendarEvent,
} from './tools/google/calendar.js';
export {
  listCoursework,
  listCourses,
  listCourseMaterials,
  listAnnouncements,
  listSubmissions,
  listTopics,
  turnInAssignment,
  unsubmitAssignment,
  attachToSubmission,
  type Assignment,
  type Attachment,
  type CourseMaterial,
  type Announcement,
  type SubmissionSummary,
  type Topic,
} from './tools/google/classroom.js';
export { readDriveFile, listDriveFiles, listAccessibleFiles } from './tools/google/drive.js';
export { readWebLink } from './tools/web/read-link.js';
export { ocrImage, ocrPdf, describeOcrFailure, type OcrResult } from './tools/ocr.js';
export {
  transcribeMedia,
  describeTranscriptionFailure,
  type AudioTranscriber,
  type TranscriptionResult,
} from './tools/transcribe.js';
export { fetchPage, htmlToText, FetchRejected } from './tools/web/fetch.js';
export * from './tools/google/scopes.js';

export {
  runAgentTurn,
  currentTimeSection,
  type AgentRunDeps,
  type AgentRunInput,
  type AgentRunResult,
} from './run.js';
