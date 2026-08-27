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
  updateStudentProfile,
  type ProfileWriterOptions,
  type ProfileWriterDeps,
} from './memory/summarize.js';
export {
  PROFILE_CHAR_LIMIT,
  capProfile,
  profileSection,
  type ProfileStore,
} from './memory/profile.js';
export { PostgresProfileStore } from './memory/profile-store.js';

export { UNTRUSTED_RULE, untrustedNote } from './untrusted.js';
export { Vault, type VaultNote, type NoteKind, type NoteSource } from './vault/vault.js';
export { renderNotes } from './vault/render.js';
export { buildGraph, type VaultGraph, type GraphNode } from './vault/graph.js';
export { searchVault } from './tools/vault.js';
export { importConversation } from './vault/conversation.js';
export { slugForNote } from './vault/slug.js';
export { importClassroom, type ClassroomSnapshot, type ImportResult } from './vault/classroom.js';
export { collectClassroomSnapshot, type Collected } from './vault/collect.js';
export { importMail, type SchoolMessage, type MailImportResult } from './vault/mail.js';
export { readFileContents, type FileReadResult } from './vault/files.js';
export { textFromDriveRead } from './vault/drive-text.js';
export { importDrive, type DriveFile, type DriveImportResult } from './vault/drive.js';
export { readUserDoc, writeUserDoc, USER_DOC_LIMIT } from './vault/user-doc.js';
export { classroomEvent } from './vault/mail.js';
export { vaultDigest, type VaultDigest } from './vault/digest.js';
export { understandVault } from './vault/understand.js';
export { askWhoTeaches } from './vault/evidence.js';
export type { Claim, Withheld } from './vault/claims.js';
export { collectDriveFiles } from './vault/collect-drive.js';
export {
  collectSchoolMail,
  discoverSchoolDomains,
  domainOf,
  type CollectedMail,
} from './vault/collect-mail.js';

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
// Exported so a caller outside the package can tell a scope refusal from a
// real answer, which is the whole shape the Google tools return.
export { isUnavailable } from './tools/google/client.js';
export {
  searchMail,
  readMail,
  readMailAttachment,
  listMailLabels,
  sendMail,
  modifyMail,
  trashMail,
  type MailAttachment,
} from './tools/google/gmail.js';
export {
  readSchoolPortal,
  refreshSchoolPortal,
  browseWithAgent,
  condense,
} from './tools/portal.js';
export { readWebLink } from './tools/web/read-link.js';
export {
  readYoutubeVideo,
  parseVideoId,
  type YoutubeMetadataSource,
  type YoutubeTranscriptSource,
  type TranscriptOutcome,
  type YoutubeVideo,
} from './tools/web/youtube.js';
export { ocrImage, ocrPdf, describeOcrFailure, type OcrResult } from './tools/ocr.js';
export {
  transcribeMedia,
  describeTranscriptionFailure,
  type AudioTranscriber,
  type TranscriptionResult,
} from './tools/transcribe.js';
export {
  fetchPage,
  htmlToText,
  FetchRejected,
  isForbiddenAddress,
  resolvePublicAddress,
  pinnedLookup,
} from './tools/web/fetch.js';
export type { IntegrationKey } from './tools/builtin.js';
export * from './tools/google/scopes.js';

export {
  runAgentTurn,
  currentTimeSection,
  SIGN_IN_SECTION,
  type AgentRunDeps,
  type AgentRunInput,
  type AgentRunResult,
} from './run.js';
