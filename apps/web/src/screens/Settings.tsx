import { useEffect, useState } from 'react';
import type { Agent, UsageStatus } from '@contexto/shared';
import { api } from '../lib/api.js';
import { DeviceConnections } from './DeviceConnections.js';
import { VaultSpace } from './VaultSpace.js';
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
export function Settings({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);

  async function load() {
    const res = await api.usage.$get();
    if (res.ok) setUsage(await res.json());

    // The vault belongs to an agent, and Settings is about the person. Nearly
    // every student has one, so the first is the right one to show.
    const agents = await api.agents.$get();
    if (agents.ok) setAgent((await agents.json()).agents[0] ?? null);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="chat-header">
        <button className="quiet" onClick={onBack}>
          ← Agents
        </button>
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
        {agent && <VaultSpace agentId={agent.id} />}
      </div>

      <GoogleConnections />

      <DeviceConnections />

      <TelegramConnection />
    </>
  );
}
