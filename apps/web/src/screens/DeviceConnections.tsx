import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

interface Device {
  id: string;
  name: string;
  lastSeenAt: string | null;
  createdAt: string;
}

function lastSeen(value: string | null): string {
  if (!value) return 'never synced';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 2) return 'syncing now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Linked computers.
 *
 * A device token is a standing credential for this account held on a machine,
 * so revoking has to be visible and one click -- a credential a student cannot
 * find is one they cannot withdraw. "Last synced" is shown for the same
 * reason: a device that stopped reporting is the most common cause of the
 * agent quietly answering from stale coursework.
 */
export function DeviceConnections() {
  const [devices, setDevices] = useState<Device[] | null>(null);

  async function load() {
    const res = await api.devices.$get();
    if (res.ok) setDevices(await res.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(device: Device) {
    if (
      !confirm(
        `Unlink ${device.name}? It will stop sending updates from the sites you signed into on it.`,
      )
    )
      return;
    await api.devices[':id'].revoke.$post({ param: { id: device.id } });
    await load();
  }

  if (!devices) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Devices</h2>
      </div>

      {devices.length === 0 ? (
        <p className="muted">No devices connected — connect with the desktop app.</p>
      ) : (
        <ul className="device-list">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span className="muted"> — {lastSeen(device.lastSeenAt)}</span>
              </div>
              <button onClick={() => void revoke(device)}>Unlink</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
