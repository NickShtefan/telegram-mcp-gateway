/** Actual original-user profile adapter. This code must never execute elevated. */
import { userInfo } from 'node:os';
import { lstat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SetupError } from './contract.js';
import { aclAccepted } from '../install/posixPermissions.js';
import type { ClientKind } from './clientConfig.js';
import type { OwnerProfile } from './clientFile.js';
const run = promisify(execFile);
export function originalOwnerProfile(clients: ClientKind[]): OwnerProfile {
  const owner = userInfo(); const home = resolve(owner.homedir);
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const helper = fileURLToPath(new URL('./client-protection.ps1', import.meta.url));
  const windows = async (path: string, privateFile: boolean, prepare = false): Promise<void> => {
    await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', path,
      ...(privateFile ? ['-PrivateFile'] : []), ...(prepare ? ['-PrepareEmptyFile'] : [])],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024, env: { SystemRoot: 'C:\\Windows' } });
  };
  const authorize = async (): Promise<void> => {
    if (process.platform !== 'win32' && (process.getuid?.() === 0 || process.getuid?.() !== owner.uid)) throw new SetupError('protection_unverified');
    if(process.env.NODE_USE_ENV_PROXY||process.execArgv.some(arg=>arg.includes('env-proxy')))throw new SetupError('protection_unverified');
    // Custom/managed/project profiles require a separate explicit profile adapter.
    const overrides: Record<ClientKind, string[]> = { codex: ['CODEX_HOME'], claude: ['CLAUDE_CONFIG_DIR'],
      opencode: ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT'], hermes: ['HERMES_HOME', 'HERMES_PROFILE'] };
    if (clients.some(client => overrides[client].some(name => !!process.env[name]))) throw new SetupError('protection_unverified');
    if (process.platform === 'win32') await windows(home, false);
  };
  return { home, authorize,
    attest: async (path, privateFile) => {
      if (path !== home && !resolve(path).startsWith(home + (process.platform === 'win32' ? '\\' : '/'))) throw new SetupError('protection_unverified');
      if (process.platform === 'win32') return windows(path, privateFile);
      for (let current = resolve(path); ; current = dirname(current)) {
        const st = await lstat(current);
        if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || ![0, owner.uid].includes(st.uid) || (st.mode & 0o022)
          || (current === path && privateFile && (st.mode & 0o077))) throw new SetupError('protection_unverified');
        if (!await aclAccepted(current, 'home')) throw new SetupError('protection_unverified');
        if (current === '/') break;
      }
    }, preparePrivateFile: process.platform === 'win32' ? path => windows(path, true, true) : undefined,
  };
}
export function installedClientProtectionPath(application: string): string { return join(application, 'dist/setup/client-protection.ps1'); }
