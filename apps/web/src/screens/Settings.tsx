import { useEffect, useState } from 'react';
import type { UsageStatus } from '@contexto/shared';
import { api } from '../lib/api.js';
import { ArchivedChats } from './ArchivedChats.js';
import { DeviceConnections } from './DeviceConnections.js';
import { VaultMap } from './VaultMap.js';
import { VaultBuild } from './VaultBuild.js';
import { GoogleConnections } from './GoogleConnections.js';
import { TelegramConnection } from './TelegramConnection.js';

/**
 * Bring-your-own-key settings.
 *
 * Note what is never rendered: the key itself. Once submitted it is encrypted
 * server-side and only ever comes back as a label and last four characters --
 * see packages/llm/src/vault.ts.
 */
export function Settings() {
  const [usage, setUsage] = useState<UsageStatus | null>(null);

  /*
   * No agent is fetched any more.
   *
   * Settings is about the person, and so is everything on this page: the
   * vault belongs to the student now. Loading an agent to reach it was what
   * hid a three and a half thousand note vault from the student who owns it,
   * the moment they deleted their agents.
   */
  async function load() {
    const res = await api.usage.$get();
    if (res.ok) setUsage(await res.json());
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      {/*
        No way back here either, for the reason the conversation has none:
        the rail is on screen with every chat on it and New at the top.
      */}
      <div className="chat-header">
        <strong>Settings</strong>
      </div>

      {usage && (
        <div className="panel">
          <div className="panel-head">
            <h2>Usage</h2>
          </div>
          <dl>
            {usage.quota ? (
              <>
                <dt>This month</dt>
                <dd>
                  {usage.quota.tokensUsed.toLocaleString()} of{' '}
                  {usage.quota.tokenLimit.toLocaleString()} included
                </dd>
              </>
            ) : (
              <>
                <dt>This month</dt>
                <dd>Unlimited</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Your vault</h2>
        </div>
        <p className="muted">
          Everything your agents have worked out about your school, as a shape. Built from your own
          Classroom, Drive and mail.
        </p>
        {/*
         * Outside the agent check on purpose. The vault belongs to the
         * student, and an account with no agents still has one -- so gating
         * the whole panel on an agent showed the largest vault on this
         * deployment to nobody.
         */}
        <VaultBuild />
        <VaultMap />
      </div>

      <ArchivedChats />

      <GoogleConnections />

      <DeviceConnections />

      <TelegramConnection />
    </>
  );
}
