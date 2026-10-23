/** Root coordinator control: freeze supervision and prove stopped before service-worker login. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { installLayout, type InstallLayout } from '../install/platform.js';
import { basename, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { attestAncestry, newProtectedDirectory, writeProtectedFile } from '../install/posixPermissions.js';
import { readProtectedRootFile } from './installed.js';
import { SetupError } from './contract.js';
const run = promisify(execFile);
const options = { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 15000, maxBuffer: 262144 };
export interface StoppedService { wasRunning: boolean; restore(activate?: boolean): Promise<void>; }
/** Pre-run supervision. Linux never changes enablement, so only `running` is meaningful there. */
export type ServiceState = z.infer<typeof stateSchema>;
const stateSchema = z.strictObject({ format_version: z.literal(1), enabled: z.boolean(), loaded: z.boolean(), running: z.boolean() });
/** A fixed root-owned file: read returns null when absent, remove tolerates absence. */
export interface ProtectedRecord { read(): Promise<Buffer | null>; write(bytes: Buffer): Promise<void>; remove(): Promise<void>; }
export interface ServiceHost { run(file: string, args: readonly string[]): Promise<string>; marker: ProtectedRecord; dropIn: ProtectedRecord; }
const dropInBytes = Buffer.from('[Service]\nRestart=no\n');

async function inspect(platform: 'darwin' | 'linux', service: string, host: ServiceHost): Promise<ServiceState> {
  if (platform === 'linux') {
    let running = false;
    try { running = (await host.run('/usr/bin/systemctl', ['is-active', `${service}.service`])).trim() === 'active'; } catch { /* Initial/inactive unit. */ }
    return { format_version: 1, enabled: false, loaded: false, running };
  }
  // The launchd override database, not the plist's Disabled default, decides enablement. An unknown format stops before any change.
  const block = /^[ \t]*disabled services = \{[ \t]*$([\s\S]*?)^[ \t]*\}[ \t]*$/m.exec(await host.run('/bin/launchctl', ['print-disabled', 'system']))?.[1];
  if (block === undefined) throw new SetupError('protection_unverified');
  const override = block.split('\n').map(line => /^\s*"([^"]+)" => (\S+)\s*$/.exec(line)).find(match => match?.[1] === service)?.[2];
  let loaded = false; let running = false;
  try { running = /^\s*pid = \d+\s*$/m.test(await host.run('/bin/launchctl', ['print', `system/${service}`])); loaded = true; } catch { /* An unloaded service is expected. */ }
  return { format_version: 1, enabled: override === 'enabled' || override === 'false', loaded, running };
}

/**
 * Records the pre-run state in a protected marker before any change and removes it only after a complete
 * restore. A marker left by an interrupted run (signal, crash, failed restore) supplies the state that run
 * found; it is merged with the current state so supervision never ends less active than before either run.
 */
export async function freezeService(platform: 'darwin' | 'linux', service: string, definition: string, host: ServiceHost): Promise<StoppedService> {
  const current = await inspect(platform, service, host);
  // Remove or reuse only the exact protected drop-in bytes, never an unrelated administrator file.
  const dropIn = platform === 'linux' ? await host.dropIn.read() : null;
  if (dropIn && !dropIn.equals(dropInBytes)) throw new SetupError('protection_unverified');
  const leftover = await host.marker.read();
  let before = current;
  if (leftover) {
    let recorded: ServiceState;
    try { recorded = stateSchema.parse(JSON.parse(leftover.toString('utf8'))); } catch { throw new SetupError('protection_unverified'); }
    before = { format_version: 1, enabled: recorded.enabled || current.enabled, loaded: recorded.loaded || current.loaded, running: recorded.running || current.running };
  } else await host.marker.write(Buffer.from(JSON.stringify(current) + '\n'));
  const target = `system/${service}`; const unit = `${service}.service`;
  const restore = async (activate = false): Promise<void> => {
    const wanted = activate ? { enabled: true, loaded: true, running: true } : before;
    if (platform === 'darwin') {
      // Freeze left the service disabled and unloaded. Bootstrap needs the override enabled; a
      // loaded-but-disabled service gets its disabled override back afterwards.
      if (wanted.enabled || wanted.loaded) await host.run('/bin/launchctl', ['enable', target]);
      if (wanted.loaded) await host.run('/bin/launchctl', ['bootstrap', 'system', definition]);
      if (wanted.running) await host.run('/bin/launchctl', ['kickstart', target]);
      if (wanted.loaded && !wanted.enabled) await host.run('/bin/launchctl', ['disable', target]);
    } else {
      const present = await host.dropIn.read();
      if (present && !present.equals(dropInBytes)) throw new SetupError('protection_unverified');
      if (present) await host.dropIn.remove();
      await host.run('/usr/bin/systemctl', ['daemon-reload']);
      if (activate) await host.run('/usr/bin/systemctl', ['enable', unit]);
      if (wanted.running) await host.run('/usr/bin/systemctl', ['start', unit]);
    }
    await host.marker.remove();
  };
  try {
    if (platform === 'darwin') {
      await host.run('/bin/launchctl', ['disable', target]);
      if (current.loaded) await host.run('/bin/launchctl', ['bootout', target]);
    } else {
      // A /run mask is shadowed by our unit in /etc. A runtime drop-in disables automatic restarts;
      // explicit starts still cannot bypass the session lease. A killed coordinator's drop-in is resumed.
      if (!dropIn) await host.dropIn.write(dropInBytes);
      await host.run('/usr/bin/systemctl', ['daemon-reload']);
      await host.run('/usr/bin/systemctl', ['stop', unit]);
    }
  } catch (err) {
    // A partial freeze is undone now when possible; otherwise the marker drives the next run.
    await restore().catch(() => undefined); throw err;
  }
  // The worker, running as the service owner, must acquire the session lease.
  // A root probe cannot use the service-owned lease's owner-only API.
  return { wasRunning: before.running, restore };
}

function protectedRecord(directory: string, name: string, create?: () => Promise<void>): ProtectedRecord {
  const path = join(directory, name);
  return {
    read: async () => {
      try { return await readProtectedRootFile(path, 1024); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
    },
    write: async bytes => { await create?.(); await writeProtectedFile(directory, name, bytes, 0o644); },
    remove: async () => { await attestAncestry(directory); await unlink(path).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }); },
  };
}

export async function stopPosixService(layout: InstallLayout): Promise<StoppedService> {
  if (process.getuid?.() !== 0 || process.platform !== layout.platform || layout.platform === 'win32') throw new SetupError('protection_unverified');
  if (JSON.stringify(layout) !== JSON.stringify(installLayout(layout.platform, basename(layout.release)))) throw new SetupError('protection_unverified');
  const dropDirectory = `/run/systemd/system/${layout.service}.service.d`;
  return freezeService(layout.platform, layout.service, layout.definition, {
    run: async (file, args) => (await run(file, [...args], options)).stdout,
    // Coordinator-owned (owner.lock) marker beside the installation receipt; it survives reboot.
    marker: protectedRecord(layout.prefix, 'owner-service.json'),
    dropIn: protectedRecord(dropDirectory, 'owner-setup.conf', async () => {
      try { await attestAncestry(dropDirectory); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await newProtectedDirectory(dropDirectory, 0, 0, 0o755);
      }
    }),
  });
}
