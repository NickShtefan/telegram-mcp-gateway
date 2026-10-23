/** Read the immutable installed profile before any owner-side mutation. */
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBoundedFile } from '../core/safeFs.js';
import { attestAncestry, attestDirectory, attestFile, attestTree } from '../install/posixPermissions.js';
import { receiptSchema, type ProvisionReceipt } from '../install/provision.js';
import { installLayout, serviceDefinition, type InstallLayout } from '../install/platform.js';
import { parseSafe, SetupError } from './contract.js';

export async function readProtectedRootFile(path: string, maximum: number): Promise<Buffer> {
  await attestAncestry(dirname(path));
  return readBoundedFile(path, { maximum, owners: [0], modeMask: 0o022, attest: attestFile, fail: () => new SetupError('protection_unverified') });
}
/** Receipt, release, service definition and state directory; the root coordinator and each root-started child run it before dropping privileges. */
export async function installedPosixProfile(sourceSha: string): Promise<{ layout: InstallLayout; receipt: ProvisionReceipt }> {
  if (process.getuid?.() !== 0 || !['darwin', 'linux'].includes(process.platform)) throw new SetupError('protection_unverified');
  const layout = installLayout(process.platform as 'darwin' | 'linux', sourceSha);
  const receipt = parseSafe(receiptSchema, JSON.parse((await readProtectedRootFile(join(layout.prefix, 'install.json'), 16384)).toString('utf8')));
  if (receipt.plan.source_sha !== sourceSha || receipt.plan.platform !== process.platform || receipt.completed.join(',') !== 'identity,release,state,definition,commands'
    || receipt.identity?.kind !== 'posix') throw new SetupError('invalid_state');
  // Attested root ancestry plus one recursive ACL listing over root-owned directories and single-link files
  // (no symlinks, special files or group/other write) instead of a subprocess per entry.
  await attestAncestry(layout.release); await attestTree(layout.release, [0], 20000);
  if (!(await readProtectedRootFile(layout.definition, 16384)).equals(Buffer.from(serviceDefinition(layout, receipt.plan.port)))) throw new SetupError('protection_unverified');
  await attestAncestry(dirname(layout.state));
  await attestDirectory(layout.state, [receipt.identity.uid], 0o077);
  return { layout, receipt };
}
/** The service-private state directory holds only the service's daemon socket and private single-link regular files. */
export async function attestServiceState(state: string, uid: number): Promise<void> {
  await attestDirectory(state, [uid], 0o077);
  for (const name of await readdir(state)) {
    const path = join(state, name); const st = await lstat(path);
    if (name === 'daemon.sock' && st.isSocket() && st.uid === uid) continue;
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o077)) throw new SetupError('protection_unverified');
    await attestFile(path, st);
  }
}
