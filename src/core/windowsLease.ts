/** Windows first-instance named pipe: kernel removes it when the owner process exits. */
import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { GatewayError } from './errors.js';
import type { FileLease } from './fileLease.js';

export function windowsLeasePath(home: string, name: string): string {
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new GatewayError('INVALID_ARGUMENT', 'Invalid lease name.');
  const path = realpathSync(home); const st = statSync(path);
  if (!st.isDirectory()) throw new GatewayError('UNAVAILABLE', 'The lease home is not a directory.');
  const identity = createHash('sha256').update(`${path.toLowerCase()}\0${st.dev}:${st.ino}\0${name}`).digest('hex');
  return `\\\\.\\pipe\\telegram-mcp-gateway-${identity}`;
}
export async function acquireWindowsLease(home: string, name: string): Promise<FileLease> {
  const path = windowsLeasePath(home, name);
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen({ path, exclusive: true }, () => resolve());
    });
  } catch { throw new GatewayError('UNAVAILABLE', 'Another process owns the Windows lease, or the pipe is unavailable.'); }
  server.unref();
  let closing: Promise<void> | undefined;
  return { release: () => closing ??= new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}
export async function isWindowsLeaseHeld(home: string, name: string): Promise<boolean> {
  let path: string;
  try { path = windowsLeasePath(home, name); } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ENOENT'; }
  return new Promise(resolve => {
    const socket = connect(path);
    const done = (held: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(held); };
    socket.once('connect', () => done(true));
    socket.once('error', err => done((err as NodeJS.ErrnoException).code !== 'ENOENT'));
    socket.setTimeout(1000, () => done(true));
  });
}
