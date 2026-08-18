import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from './sync.mjs';

describe('readConfig', () => {
  it('returns an empty object rather than throwing when unlinked', () => {
    // First run on a new machine has no config file at all. Throwing here
    // would mean the app cannot even print "run link first".
    expect(readConfig()).toEqual(expect.any(Object));
  });

  it('survives a corrupted config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    chmodSync(file, 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
