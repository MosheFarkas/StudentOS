import type { z } from 'zod';
import type { ScopeGroup } from './google/scopes.js';
import type { AudioTranscriber } from './transcribe.js';

/**
 * Something an agent can do in the world.
 *
 * Tools are declared with a Zod schema so the handler gets a parsed, validated
 * input rather than whatever JSON the model produced. The registry converts the
 * schema to JSON Schema at the provider boundary -- tool authors never write
 * JSON Schema by hand.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Stable identifier. Referenced by skills, so renaming one breaks them. */
  id: string;
  /** Shown to the model. Say WHEN to call it, not just what it does. */
  description: string;
  /**
   * OAuth scopes this tool's API calls actually need.
   *
   * Registration is gated on these, so a student whose school granted only
   * some scopes loses exactly the tools that would have 403'd -- and keeps
   * the rest. Without this, a partial grant either breaks the whole
   * integration or leaves tools that fail every time they are called.
   */
  requiredScopes?: readonly string[];
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export interface ToolContext {
  userId: string;
  agentId: string;
  /**
   * Present only for tools that need Google APIs, and only once the student has
   * granted the relevant scope group. Undefined means "not connected" -- a tool
   * should return a clear, student-readable message rather than throwing.
   */
  google?: GoogleTokenProvider;
  /**
   * Turns audio into text. Absent when transcription is not configured, which
   * a tool must report rather than treat as a broken file.
   */
  transcriber?: AudioTranscriber;
  signal?: AbortSignal;
}

/**
 * Supplies a fresh Google access token, refreshing as needed.
 *
 * This is the seam OAuth plugs into. Nothing in the tool layer knows how tokens
 * are obtained, stored, or refreshed -- it asks for a token and gets one, or
 * gets null when the scope was never granted.
 *
 * TODO(oauth): implement in apps/api over Better Auth's `account` table, which
 * already stores refreshToken and accessTokenExpiresAt.
 */
export interface GoogleTokenProvider {
  /**
   * Derived from ScopeGroup rather than listed, so adding a group cannot
   * leave this signature behind -- 'identity' is excluded because it is
   * granted at sign-in and no tool asks for it.
   */
  getAccessToken(scopeGroup: Exclude<ScopeGroup, 'identity'>): Promise<string | null>;

  /**
   * Whether one specific scope was granted.
   *
   * Registration already gates on required scopes, so this is for tools whose
   * BEHAVIOUR changes with an optional scope rather than their availability --
   * reading one picked file versus searching a whole Drive.
   */
  hasScope(scope: string): boolean;
}

/** Returned when a tool cannot run for a reason the student can act on. */
export interface ToolUnavailable {
  unavailable: true;
  reason: string;
}

export function unavailable(reason: string): ToolUnavailable {
  return { unavailable: true, reason };
}
