import { useEffect, useState } from 'react';
import type { ByokProvider, CredentialSummary, UsageStatus } from '@contexto/shared';
import { api } from '../lib/api.js';
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
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [credentialsRes, usageRes] = await Promise.all([
      api.credentials.$get(),
      api.usage.$get(),
    ]);
    if (credentialsRes.ok) setCredentials((await credentialsRes.json()).credentials);
    if (usageRes.ok) setUsage(await usageRes.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    await api.credentials[':id'].$delete({ param: { id } });
    void load();
  }

  return (
    <>
      <div className="chat-header">
        <button onClick={onBack}>← Agents</button>
        <strong>Settings</strong>
      </div>

      {usage && (
        <div className="panel">
          <dl>
            <dt>Currently using</dt>
            <dd>
              {usage.activeProvider === 'platform' ? 'Included free tier' : 'Your own API key'}
            </dd>
            {usage.quota && (
              <>
                <dt>Used this month</dt>
                <dd>
                  {usage.quota.tokensUsed.toLocaleString()} /{' '}
                  {usage.quota.tokenLimit.toLocaleString()} tokens
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <GoogleConnections />

      <TelegramConnection />

      <div className="panel">
        <h2>Your API keys</h2>
        <p className="muted">
          Add your own key for unlimited use. It&apos;s encrypted before it&apos;s stored, and never
          shown again.
        </p>

        {credentials.map((credential) => (
          <div key={credential.id} className="row static">
            <span>
              <strong>{credential.label}</strong>{' '}
              <span className="muted">
                {credential.provider} ····{credential.last4}
              </span>
            </span>
            <button onClick={() => void remove(credential.id)}>Remove</button>
          </div>
        ))}

        <AddCredential
          onAdded={() => {
            setError(null);
            void load();
          }}
          onError={setError}
        />
        {error && <p className="muted">{error}</p>}
      </div>
    </>
  );
}

function AddCredential({
  onAdded,
  onError,
}: {
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const [provider, setProvider] = useState<ByokProvider>('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);

    try {
      const res = await api.credentials.$post({ json: { provider, label, apiKey } });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? `Could not save key (${res.status})`);
      }
      setLabel('');
      setApiKey('');
      onAdded();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value as ByokProvider)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>

      <label>
        Label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="My key"
          maxLength={64}
          required
        />
      </label>

      <label>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          required
        />
      </label>

      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Add key'}
      </button>
    </form>
  );
}
