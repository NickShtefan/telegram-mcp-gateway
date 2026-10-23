/** Fixed platform account operations. Never import or reuse other projects' identities. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstallLayout } from './platform.js';
import type { ServiceIdentity } from './provision.js';
import { ProtectionError } from './posixPermissions.js';
const run = promisify(execFile);
const options = { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 10000, maxBuffer: 65_536 };

export async function createPosixIdentity(layout: InstallLayout): Promise<ServiceIdentity> {
  if (process.getuid?.() !== 0 || process.platform !== layout.platform) throw new ProtectionError();
  if (layout.platform === 'darwin') {
    // Any existing account requires a previously validated receipt, handled by resume.
    try { await run('/usr/bin/id', ['-u', layout.account], options); throw new ProtectionError(); }
    catch (err) { if (err instanceof ProtectionError || (err as { code?: number }).code !== 1) throw err; }
    const users = await run('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID'], options);
    const groups = await run('/usr/bin/dscl', ['.', '-list', '/Groups', 'PrimaryGroupID'], options);
    if (groups.stdout.split('\n').some(line => line.trim().split(/\s+/)[0] === layout.account)) throw new ProtectionError();
    const used = new Set([...users.stdout.split('\n'), ...groups.stdout.split('\n')].map(line => Number(line.trim().split(/\s+/).at(-1))));
    const uid = Array.from({ length: 99 }, (_, i) => i + 401).find(id => !used.has(id));
    if (uid === undefined) throw new ProtectionError();
    const group = `/Groups/${layout.account}`; const user = `/Users/${layout.account}`;
    for (const args of [
      ['-create', group], ['-create', group, 'PrimaryGroupID', String(uid)], ['-create', group, 'Password', '*'],
      ['-create', user], ['-create', user, 'UniqueID', String(uid)], ['-create', user, 'PrimaryGroupID', String(uid)],
      ['-create', user, 'RealName', 'Telegram MCP Gateway'], ['-create', user, 'NFSHomeDirectory', '/var/empty'],
      ['-create', user, 'UserShell', '/usr/bin/false'], ['-create', user, 'Password', '*'], ['-create', user, 'IsHidden', '1'],
    ]) await run('/usr/bin/dscl', ['.', ...args], options);
    return { kind: 'posix', uid, gid: uid };
  }
  if (layout.platform === 'linux') {
    try { await run('/usr/bin/id', ['-u', layout.account], options); throw new ProtectionError(); }
    catch (err) { if (err instanceof ProtectionError || (err as { code?: number }).code !== 1) throw err; }
    await run('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', layout.state, '--shell', '/usr/sbin/nologin', layout.account], options);
    const uid = Number((await run('/usr/bin/id', ['-u', layout.account], options)).stdout.trim());
    const gid = Number((await run('/usr/bin/id', ['-g', layout.account], options)).stdout.trim());
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid === 0 || gid === 0) throw new ProtectionError();
    return { kind: 'posix', uid, gid };
  }
  throw new ProtectionError();
}
