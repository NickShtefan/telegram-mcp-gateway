/** Root read-only service/listener proof before any credential is released to a client. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readlink, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { installLayout, type InstallLayout } from '../install/platform.js';
import { SetupError } from './contract.js';
const run = promisify(execFile);
const options = { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 2000, maxBuffer: 65536 };
export async function attestManagedListener(layout: InstallLayout, uid: number, port: number): Promise<void> {
  if (process.getuid?.() !== 0 || !['darwin','linux'].includes(layout.platform) || JSON.stringify(layout) !== JSON.stringify(installLayout(layout.platform, basename(layout.release)))
    || !Number.isInteger(port) || port < 1 || port > 65535 || uid <= 0) throw new SetupError('protection_unverified');
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      if (layout.platform === 'darwin') {
        const status = (await run('/bin/launchctl', ['print', `system/${layout.service}`], options)).stdout;
        const pid = /^\s*pid = (\d+)\s*$/m.exec(status)?.[1]; if (!pid) throw new Error();
        if (Number((await run('/bin/ps', ['-o', 'uid=', '-p', pid], options)).stdout.trim()) !== uid) throw new Error();
        const image = (await run('/usr/sbin/lsof', ['-a','-p',pid,'-d','txt','-Fn'], options)).stdout.split('\n');
        if (!image.includes('n'+layout.node)) throw new Error();
        const listeners = (await run('/usr/sbin/lsof', ['-a','-p',pid,`-iTCP:${port}`,'-sTCP:LISTEN','-Fp'], options)).stdout.split('\n');
        if (!listeners.includes('p'+pid)) throw new Error();
        return;
      }
      const pid = (await run('/usr/bin/systemctl', ['show', `${layout.service}.service`, '--property=MainPID', '--value'], options)).stdout.trim();
      if (!/^[1-9]\d*$/.test(pid) || await readlink(`/proc/${pid}/exe`) !== layout.node) throw new Error();
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if (!ids || ids.slice(1).some(id => Number(id) !== uid)) throw new Error();
      const portHex = port.toString(16).toUpperCase().padStart(4,'0');
      const sockets = (await readFile('/proc/net/tcp','utf8')).split('\n').map(line=>line.trim().split(/\s+/))
        .filter(fields=>fields[1]===`0100007F:${portHex}`&&fields[3]==='0A'&&fields[7]===String(uid)).map(fields=>`socket:[${fields[9]}]`);
      for (const name of await readdir(`/proc/${pid}/fd`)) { try { if (sockets.includes(await readlink(join(`/proc/${pid}/fd`,name)))) return; } catch { /* FD disappeared. */ } }
    } catch { /* Startup/restart observations are bounded and never returned raw. */ }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw new SetupError('protection_unverified');
}
