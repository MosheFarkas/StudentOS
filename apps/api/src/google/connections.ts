import { and, eq } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { account } from '@contexto/db';
import {
  grantedScopeGroups,
  hasScope,
  parseGrantedScopes,
  type GoogleTokenProvider,
  type ScopeGroup,
} from '@contexto/agent';
import type { Auth } from '../auth.js';

const GOOGLE_PROVIDER_ID = 'google';

/**
 * Which Google scope groups a student has granted.
 *
 * Read from the stored `scope` string on the linked account rather than by
 * minting a token -- this runs on every agent turn to decide which tools to
 * register, and it should not cost a network call when the answer is usually
 * "none".
 */
export interface GoogleGrant {
  /** Raw scope string as stored, for per-tool gating. */
  scope: string | null;
  /** Groups whose required scopes are all present. */
  groups: ScopeGroup[];
}

/**
 * What this student has granted Google-side.
 *
 * Returns the raw scope string as well as the groups, because tool
 * registration is per-scope rather than per-group -- schools grant subsets,
 * and a tool should be withheld only if the scope IT needs is missing.
 */
export async function getGoogleGrant(db: Database, userId: string): Promise<GoogleGrant> {
  const [row] = await db
    .select({ scope: account.scope })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, GOOGLE_PROVIDER_ID)))
    .limit(1);

  const scope = row?.scope ?? null;
  return { scope, groups: grantedScopeGroups(scope) };
}

/**
 * Supplies fresh Google access tokens to tools.
 *
 * Better Auth's getAccessToken refreshes using the stored refresh token when
 * the access token has expired, so nothing here has to track expiry. That is
 * also why apps/api/src/auth.ts sets accessType 'offline' and prompt 'consent'
 * -- without a refresh token this works for an hour and then quietly stops.
 */
export class BetterAuthGoogleTokenProvider implements GoogleTokenProvider {
  private readonly grantedScopes: Set<string>;

  constructor(
    private readonly auth: Auth,
    private readonly userId: string,
    private readonly granted: ScopeGroup[],
    grantedScope: string | null = null,
  ) {
    this.grantedScopes = parseGrantedScopes(grantedScope);
  }

  hasScope(scope: string): boolean {
    return hasScope(scope, this.grantedScopes);
  }

  async getAccessToken(scopeGroup: Exclude<ScopeGroup, 'identity'>): Promise<string | null> {
    // Checked before minting: a token is useless for a scope the student never
    // granted, and asking for one costs a round trip to answer "no".
    if (!this.granted.includes(scopeGroup)) {
      return null;
    }

    try {
      const result = await this.auth.api.getAccessToken({
        body: { providerId: GOOGLE_PROVIDER_ID, userId: this.userId },
      });
      return result.accessToken;
    } catch {
      // Refresh can fail permanently -- the student revoked access from their
      // Google account, or an admin blocked the app since they connected.
      // Returning null makes the tool report "reconnect in Settings", which is
      // the actionable message; throwing would surface as a generic failure.
      return null;
    }
  }
}
