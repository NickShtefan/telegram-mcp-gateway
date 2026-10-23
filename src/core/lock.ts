/**
 * The permanent kernel lease owns sessions; the Unix socket is a liveness
 * endpoint retained for compatibility with older daemons. Serialize stale
 * socket reclamation under the lease so concurrent restarts cannot unlink
 * a newly acquired owner's socket. Kernel ownership ends on process death.
 */
import { chmodSync, lstatSync, unlinkSync, type Stats } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { GatewayError } from './errors.js';
import { acquireFileLease, isFileLeaseHeld } from './fileLease.js';
import { windowsLeasePath } from './windowsLease.js';

const LEASE_NAME = 'sessions.lock';

export function lockPath(home: string): string {
  if (process.platform === 'win32') return windowsLeasePath(home, LEASE_NAME);
  return join(home, 'daemon.sock');
}

/** Unix socket sun_path limits: 104 bytes on macOS, 108 on Linux, including the NUL terminator. */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

function pathFits(path: string): boolean {
  return Buffer.byteLength(path) <= SOCKET_PATH_MAX;
}

function pathTooLong(home: string): GatewayError {
  return new GatewayError(
    'INVALID_ARGUMENT',
    `The gateway folder path is too long for the lock socket (${Buffer.byteLength(lockPath(home))} bytes, the system limit is ${SOCKET_PATH_MAX}): ${home}. Set TG_MCP_HOME to a shorter path.`,
  );
}

/** Whether a live process answers on the lock socket. */
function inspectSocket(path: string): Stats | null {
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o022) !== 0) {
      throw new GatewayError('UNAVAILABLE', 'The gateway liveness endpoint requires owner review.');
    }
    return st;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function probeSocket(home: string, timeoutMs = 1_000): Promise<'live' | 'stale' | 'missing' | 'unsafe'> {
  const path = lockPath(home);
  // The path cannot host a socket, so it cannot have an owner.
  if (!pathFits(path)) return Promise.resolve('missing');
  try { if (!inspectSocket(path)) return Promise.resolve('missing'); }
  catch { return Promise.resolve('unsafe'); }
  return new Promise<'live' | 'stale' | 'missing' | 'unsafe'>(resolve => {
    const socket = connect(path);
    const done = (held: 'live' | 'stale' | 'missing' | 'unsafe'): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs, () => done('live'));
    socket.once('connect', () => done('live'));
    socket.once('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      done(code === 'ECONNREFUSED' ? 'stale' : code === 'ENOENT' ? 'missing' : 'unsafe');
    });
  });
}

export async function isLockHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
  if (process.platform === 'win32') return isFileLeaseHeld(home, LEASE_NAME);
  const socket = await probeSocket(home, timeoutMs);
  if (socket === 'live' || socket === 'unsafe') return true;
  return isFileLeaseHeld(home, LEASE_NAME);
}

export interface DaemonLock {
  release(): Promise<void>;
}

/**
 * Acquire kernel ownership before probing/reclaiming the compatibility socket.
 */
export async function acquireLock(home: string): Promise<DaemonLock> {
  if (process.platform === 'win32') return acquireFileLease(home, LEASE_NAME);
  const path = lockPath(home);
  if (!pathFits(path)) throw pathTooLong(home);
  const held = (): GatewayError =>
    new GatewayError(
      'UNAVAILABLE',
      `Another tg-mcp process already owns the Telegram sessions in ${home}. Only one process may open them (AUTH_KEY_DUPLICATED otherwise).`,
    );

  const lease = await acquireFileLease(home, LEASE_NAME);

  const listen = (): Promise<Server> =>
    new Promise<Server>((resolve, reject) => {
      const server: Server = createServer(socket => {
        // The socket only proves liveness; close connections immediately.
        socket.destroy();
      });
      server.once('error', reject);
      // The umask (002 for Ubuntu user groups) must not leave a group-writable endpoint that a restart after a crash rejects as unsafe.
      server.listen(path, () => {
        try { chmodSync(path, 0o600); resolve(server); } catch (err) { server.close(); reject(err); }
      });
    });

  let server: Server;
  try {
    inspectSocket(path);
    try {
      server = await listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      // Old versions own only the socket, so they must still block new clients.
      const before = inspectSocket(path);
      if (!before) throw held();
      if (await probeSocket(home) !== 'stale') throw held();
      const after = inspectSocket(path);
      if (!after || after.ino !== before.ino || after.dev !== before.dev) throw held();
      unlinkSync(path);
      server = await listen();
    }
  } catch (err) { await lease.release(); throw err; }
  server.unref();

  let released: Promise<void> | undefined;
  return {
    // Node removes its own socket on close. Do not unlink again afterward:
    // an older daemon could already have bound a fresh compatibility socket.
    release: () => released ??= new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }).finally(() => lease.release()),
  };
}
