import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attestServiceState } from '../installed.js';

const posix = process.platform === 'darwin' || process.platform === 'linux';
const aclTools = process.platform === 'darwin' || (existsSync('/usr/bin/getfacl') && existsSync('/usr/bin/setfacl'));
const uid = process.getuid?.() ?? -1;

describe.skipIf(!posix || !aclTools)('service state attestation', () => {
  let state: string; let server: Server;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), 'tg-state-')); chmodSync(state, 0o700);
    for (const name of ['gateway.sqlite', 'setup.lock', '.env']) writeFileSync(join(state, name), 'synthetic', { mode: 0o600 });
    server = createServer(); server.listen(join(state, 'daemon.sock')); await once(server, 'listening');
  });
  afterEach(async () => { server.close(); rmSync(state, { recursive: true, force: true }); });

  it('accepts the service socket and private single-link regular files', async () => {
    await expect(attestServiceState(state, uid)).resolves.toBeUndefined();
  });
  it('rejects readable, linked, ACL-bearing or foreign entries and an unknown socket', async () => {
    const file = join(state, '.env');
    const cases: [string, () => void, () => void, number?][] = [
      ['readable file', () => chmodSync(file, 0o640), () => chmodSync(file, 0o600)],
      ['readable directory', () => chmodSync(state, 0o750), () => chmodSync(state, 0o700)],
      ['symlink', () => symlinkSync(file, join(state, 'link')), () => rmSync(join(state, 'link'))],
      ['hard link', () => linkSync(file, join(state, 'second')), () => rmSync(join(state, 'second'))],
      ['file ACL', () => execFileSync(process.platform === 'darwin' ? '/bin/chmod' : '/usr/bin/setfacl',
        process.platform === 'darwin' ? ['+a', `user:${userInfo().username} allow write`, file] : ['-m', 'u:nobody:r', file]),
      () => execFileSync(process.platform === 'darwin' ? '/bin/chmod' : '/usr/bin/setfacl', process.platform === 'darwin' ? ['-N', file] : ['-b', file])],
      ['foreign owner', () => undefined, () => undefined, uid + 1],
    ];
    for (const [name, apply, undo, owner = uid] of cases) {
      apply();
      await expect(attestServiceState(state, owner), name).rejects.toThrow('protection_unverified');
      undo(); await expect(attestServiceState(state, uid), name).resolves.toBeUndefined();
    }
    const other = createServer(); other.listen(join(state, 'other.sock')); await once(other, 'listening');
    try { await expect(attestServiceState(state, uid)).rejects.toThrow('protection_unverified'); } finally { other.close(); }
  });
});
