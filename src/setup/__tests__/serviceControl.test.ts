import { describe, expect, it } from 'vitest';
import { freezeService, type ProtectedRecord, type ServiceHost } from '../serviceControl.js';

const label = 'io.telegram-mcp-gateway'; const plist = '/Library/LaunchDaemons/io.telegram-mcp-gateway.plist';
const unit = 'telegram-mcp-gateway'; const dropIn = Buffer.from('[Service]\nRestart=no\n');
type StoredRecord = ProtectedRecord & { value: Buffer | null };
function record(value: Buffer | null = null): StoredRecord {
  const stored: StoredRecord = { value, read: async () => stored.value,
    write: async bytes => { if (stored.value) throw new Error('no overwrite'); stored.value = bytes; }, remove: async () => { stored.value = null; } };
  return stored;
}
const marker = (state: { enabled: boolean; loaded: boolean; running: boolean }): Buffer => Buffer.from(JSON.stringify({ format_version: 1, ...state }) + '\n');
/** Synthetic launchctl/systemctl: read-only probes answer from `state`, mutations are only recorded. */
function host(state: { override?: string; loaded?: boolean; running?: boolean; active?: boolean; listing?: string; fail?: string }, initial: { marker?: Buffer; dropIn?: Buffer } = {}) {
  const calls: string[] = []; let markedFirst = true;
  const fake: ServiceHost & { marker: StoredRecord; dropIn: StoredRecord } = {
    marker: record(initial.marker ?? null), dropIn: record(initial.dropIn ?? null),
    run: async (file, args) => {
      if (args[0] === 'print-disabled') return state.listing ?? `disabled services = {\n\t"com.example.other" => enabled\n${state.override ? `\t"${label}" => ${state.override}\n` : ''}}\n\nlogin item associations = {\n}\n`;
      if (args[0] === 'print') { if (!state.loaded) throw new Error('not loaded'); return `system/${label} = {\n\tstate = ${state.running ? 'running' : 'waiting'}\n${state.running ? '\tpid = 4242\n' : ''}}\n`; }
      if (args[0] === 'is-active') { if (!state.active) throw new Error('inactive'); return 'active\n'; }
      if (!fake.marker.value) markedFirst = false;
      const call = [file.split('/').at(-1), ...args].join(' '); calls.push(call);
      if (state.fail && call.includes(state.fail)) throw new Error('synthetic failure');
      return '';
    },
  };
  return { fake, calls, markedFirst: () => markedFirst };
}

describe('POSIX supervision freeze and faithful restore', () => {
  it('restores a running macOS service exactly and records the pre-run state before any change', async () => {
    const { fake, calls, markedFirst } = host({ override: 'enabled', loaded: true, running: true });
    const stopped = await freezeService('darwin', label, plist, fake);
    expect(calls).toEqual([`launchctl disable system/${label}`, `launchctl bootout system/${label}`]);
    expect(stopped.wasRunning).toBe(true); expect(markedFirst()).toBe(true);
    expect(JSON.parse(fake.marker.value!.toString())).toEqual({ format_version: 1, enabled: true, loaded: true, running: true });
    calls.length = 0; await stopped.restore();
    expect(calls).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`, `launchctl kickstart system/${label}`]);
    expect(fake.marker.value).toBeNull();
  });
  it('leaves a never-enabled initial macOS service disabled unless activation is requested', async () => {
    const first = host({});
    const stopped = await freezeService('darwin', label, plist, first.fake);
    expect(first.calls).toEqual([`launchctl disable system/${label}`]);
    first.calls.length = 0; await stopped.restore();
    expect(first.calls).toEqual([]); expect(first.fake.marker.value).toBeNull();
    const second = host({});
    await (await freezeService('darwin', label, plist, second.fake)).restore(true);
    expect(second.calls.slice(1)).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`, `launchctl kickstart system/${label}`]);
  });
  it('re-enables an enabled but unloaded macOS service and does not start a loaded idle one', async () => {
    const idle = host({ override: 'enabled' });
    await (await freezeService('darwin', label, plist, idle.fake)).restore();
    expect(idle.calls).toEqual([`launchctl disable system/${label}`, `launchctl enable system/${label}`]);
    const loaded = host({ override: 'false', loaded: true });
    await (await freezeService('darwin', label, plist, loaded.fake)).restore();
    expect(loaded.calls.slice(2)).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`]);
  });
  it('reinstates the disabled override of a service that was loaded while disabled', async () => {
    const { fake, calls } = host({ override: 'disabled', loaded: true });
    await (await freezeService('darwin', label, plist, fake)).restore();
    expect(calls.slice(2)).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`, `launchctl disable system/${label}`]);
  });
  it('recovers the state found by an interrupted macOS run instead of treating it as disabled', async () => {
    const left = marker({ enabled: true, loaded: true, running: true });
    const { fake, calls } = host({ override: 'disabled' }, { marker: left });
    const stopped = await freezeService('darwin', label, plist, fake);
    expect(stopped.wasRunning).toBe(true); expect(fake.marker.value).toEqual(left);
    expect(calls).toEqual([`launchctl disable system/${label}`]);
    calls.length = 0; await stopped.restore();
    expect(calls).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`, `launchctl kickstart system/${label}`]);
    expect(fake.marker.value).toBeNull();
  });
  it('fails closed before any change on an unknown override listing or a corrupt marker', async () => {
    const unknown = host({ listing: 'unexpected format\n' });
    await expect(freezeService('darwin', label, plist, unknown.fake)).rejects.toThrow('protection_unverified');
    expect(unknown.calls).toEqual([]); expect(unknown.fake.marker.value).toBeNull();
    const corrupt = host({ override: 'enabled', loaded: true }, { marker: Buffer.from('{"format_version":1}\n') });
    await expect(freezeService('darwin', label, plist, corrupt.fake)).rejects.toThrow('protection_unverified');
    expect(corrupt.calls).toEqual([]);
  });
  it('keeps the marker when restore fails and undoes a partial freeze when it can', async () => {
    const failing = host({ override: 'enabled', loaded: true, running: true, fail: 'kickstart' });
    const stopped = await freezeService('darwin', label, plist, failing.fake);
    await expect(stopped.restore()).rejects.toThrow('synthetic failure');
    expect(failing.fake.marker.value).not.toBeNull();
    const partial = host({ override: 'enabled', loaded: true, fail: 'bootout' });
    await expect(freezeService('darwin', label, plist, partial.fake)).rejects.toThrow('synthetic failure');
    expect(partial.calls.slice(2)).toEqual([`launchctl enable system/${label}`, `launchctl bootstrap system ${plist}`]);
    expect(partial.fake.marker.value).toBeNull();
  });
  it('stops an active Linux unit behind the runtime drop-in and starts it again on restore', async () => {
    const { fake, calls, markedFirst } = host({ active: true });
    const stopped = await freezeService('linux', unit, `/etc/systemd/system/${unit}.service`, fake);
    expect(calls).toEqual(['systemctl daemon-reload', `systemctl stop ${unit}.service`]);
    expect(fake.dropIn.value).toEqual(dropIn); expect(markedFirst()).toBe(true); expect(stopped.wasRunning).toBe(true);
    calls.length = 0; await stopped.restore();
    expect(calls).toEqual(['systemctl daemon-reload', `systemctl start ${unit}.service`]);
    expect(fake.dropIn.value).toBeNull(); expect(fake.marker.value).toBeNull();
  });
  it('starts a Linux unit stopped by an interrupted run and enables it only on activation', async () => {
    const left = marker({ enabled: false, loaded: false, running: true });
    const resumed = host({}, { marker: left, dropIn });
    const stopped = await freezeService('linux', unit, `/etc/systemd/system/${unit}.service`, resumed.fake);
    expect(stopped.wasRunning).toBe(true);
    await stopped.restore();
    expect(resumed.calls.slice(2)).toEqual(['systemctl daemon-reload', `systemctl start ${unit}.service`]);
    const initial = host({});
    await (await freezeService('linux', unit, `/etc/systemd/system/${unit}.service`, initial.fake)).restore(true);
    expect(initial.calls.slice(2)).toEqual(['systemctl daemon-reload', `systemctl enable ${unit}.service`, `systemctl start ${unit}.service`]);
  });
  it('never replaces or removes a foreign Linux drop-in', async () => {
    const { fake, calls } = host({ active: true }, { dropIn: Buffer.from('[Service]\nRestart=always\n') });
    await expect(freezeService('linux', unit, `/etc/systemd/system/${unit}.service`, fake)).rejects.toThrow('protection_unverified');
    expect(calls).toEqual([]); expect(fake.marker.value).toBeNull();
  });
});
