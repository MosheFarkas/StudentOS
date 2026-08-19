#!/usr/bin/env node
/**
 * Finish Electron's install when its own postinstall quietly does not.
 *
 * On Node 24, extract-zip opens the first entry of the Electron archive and
 * the process exits 0 having written one licenses file and nothing else. The
 * download is fine -- the checksum validates -- so nothing reports an error,
 * and the failure only surfaces later as "Electron failed to install
 * correctly" when something tries to run it.
 *
 * pnpm compounds it: adding a dependency that changes Electron's peer
 * suffix creates a fresh package directory, which fails the same way, so a
 * hand-extraction does not stay fixed.
 *
 * This checks for the binary and, if it is missing, extracts the archive
 * Electron already downloaded and verified. A no-op when the install worked.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function electronDir() {
  try {
    return dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }
}

/** Where Electron caches the archive it downloaded, per platform. */
function cacheRoot() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'electron');
  if (platform() === 'win32')
    return join(process.env['LOCALAPPDATA'] ?? homedir(), 'electron', 'Cache');
  return join(homedir(), '.cache', 'electron');
}

function findCachedZip(root) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.zip')) return path;
    if (entry.isDirectory()) {
      const found = findCachedZip(path);
      if (found) return found;
    }
  }
  return null;
}

const pkg = electronDir();
if (!pkg) process.exit(0); // Electron is not installed here; nothing to repair.

const binary =
  platform() === 'darwin'
    ? join(pkg, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : platform() === 'win32'
      ? join(pkg, 'dist', 'electron.exe')
      : join(pkg, 'dist', 'electron');

if (existsSync(binary)) process.exit(0);

const zip = findCachedZip(cacheRoot());
if (!zip) {
  console.error('[desktop] Electron is unpacked incorrectly and no cached archive was found.');
  console.error('[desktop] Re-run: pnpm install --filter @contexto/desktop');
  process.exit(0); // Warn, but never fail an install over it.
}

console.log('[desktop] Electron unpacked incompletely; extracting from its own cache.');
const dist = join(pkg, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

try {
  // tar reads zip on Windows 10+; unzip preserves the symlinks inside the app
  // bundle on macOS, which matters -- a copy without them will not launch.
  if (platform() === 'win32') execFileSync('tar', ['-xf', zip, '-C', dist], { stdio: 'ignore' });
  else execFileSync('unzip', ['-q', zip, '-d', dist], { stdio: 'ignore' });

  writeFileSync(
    join(pkg, 'path.txt'),
    platform() === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : platform() === 'win32'
        ? 'electron.exe'
        : 'electron',
  );
  console.log(
    existsSync(binary)
      ? '[desktop] Electron repaired.'
      : '[desktop] Extraction ran but the binary is still missing.',
  );
} catch (error) {
  console.error(`[desktop] Could not extract Electron: ${error.message}`);
}
