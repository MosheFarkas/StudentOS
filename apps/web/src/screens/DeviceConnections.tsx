import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Row } from './SettingsRow.js';

interface Device {
  id: string;
  name: string;
  lastSeenAt: string | null;
  createdAt: string;
}

/** When a computer last reported, as the line under its name. */
export function lastSynced(value: string | null): string {
  if (!value) return 'Never synced';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 2) return 'Syncing now';
  if (minutes < 60) return `Last synced ${count(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last synced ${count(hours, 'hour')} ago`;
  return `Last synced ${count(Math.round(hours / 24), 'day')} ago`;
}

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

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
    <>
      <h2 className="settings-heading">Linked computers</h2>

      {devices.length === 0 ? (
        <p className="settings-empty">
          No computers linked yet. Link one from the desktop app and it will keep your agent up to
          date with the sites you sign into there.
        </p>
      ) : (
        devices.map((device) => (
          <Row key={device.id} label={device.name} hint={lastSynced(device.lastSeenAt)}>
            <button onClick={() => void revoke(device)}>Unlink</button>
          </Row>
        ))
      )}
    </>
  );
}
