/** Original-user human terminal. Privileged children receive only closed private protocol messages. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { terminalIo } from '../cli/io.js';
import { ownerLabels, ownerClients, ownerCommand, sudoPrompt } from './presentation.js';
import { installLayout, type InstallLayout } from '../install/platform.js';
import { ownerPlanSchema } from './owner.js';
import { originalOwnerProfile } from './ownerProfile.js';
import { configureClient, readSelectedClientTokens } from './clientFile.js';
import { probeConfiguredGateway } from './clientProbe.js';
import { SetupError } from './contract.js';
import { withTimeout } from '../core/time.js';
import { runOwnerConversation, type ElevatedPeer } from './ownerConversation.js';

async function main(): Promise<number> {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stderr.isTTY || !['darwin', 'linux', 'win32'].includes(process.platform)) throw new SetupError('protection_unverified');
  const platform = process.platform as 'darwin' | 'linux' | 'win32';
  const sha = dirname(process.execPath).split(/[\\/]/).at(-1)!;
  const layout = installLayout(platform, sha);
  if (fileURLToPath(import.meta.url) !== join(layout.application, 'dist/setup/ownerLauncher.js') || process.execPath !== layout.node) throw new SetupError('protection_unverified');
  terminalIo.err('Stop all agents and disable terminal capture/UI automation. Same-user software can read your input and client credentials.');
  terminalIo.err('OWNER READY confirms that you, not an agent, control this terminal and have stopped input capture before secret entry.');
  if (await terminalIo.prompt('Type OWNER READY after completing those steps: ') !== 'OWNER READY') throw new SetupError('invalid_request');
  const {account,user}=await ownerLabels(terminalIo);
  const clients = await ownerClients(terminalIo);
  const preview = ownerPlanSchema.parse({ setup_id: randomUUID(), account, user, clients });
  const owner = originalOwnerProfile(preview.clients); await owner.authorize();
  return runOwnerConversation({ io: terminalIo, platform, sha, preview, rerunCommand: ownerCommand(layout),
    elevate: async () => platform === 'win32' ? elevateWindows(layout, sha) : elevatePosix(layout, sha),
    existingTokens: port => readSelectedClientTokens(owner, preview.clients, port),
    configure: async (client, port, token, replace) => { await configureClient(owner, client, port, token, replace); },
    probe: probeConfiguredGateway });
}
function elevatePosix(layout: InstallLayout, sha: string): ElevatedPeer {
  // sudo's fixed prompt names the computer's administrator password, so it is not mistaken for a Telegram value.
  const child = spawn('/usr/bin/sudo', ['-p', sudoPrompt, '--', layout.node, join(layout.application, 'dist/setup/ownerCli.js'), 'root-channel', sha],
    { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'close').then(([code]) => code as number | null);
  // A coordinator that outlives its ended input gets SIGTERM, which sudo relays to its restoring cleanup.
  child.on('error', () => undefined);
  return { input: child.stdout, output: child.stdin, closing: async () => {
    child.stdin.end();
    try { return await withTimeout(exited, 30000, 'owner coordinator exit'); } catch (err) { child.kill('SIGTERM'); throw err; }
  } };
}
async function elevateWindows(layout: InstallLayout, sha: string): Promise<ElevatedPeer> {
  const id = randomUUID(); const pipeName = `\\\\.\\pipe\\TelegramMCPSetup-${id}`;
  const server = createServer(); server.maxConnections = 1;
  const connected = once(server, 'connection').then(([socket]) => socket as Socket);
  server.listen(pipeName); await once(server, 'listening');
  const helper = join(layout.application, 'dist/native/service-host.exe');
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  // Only validated fixed-path/hex arguments appear in the elevation request.
  const quote = (value: string): string => "'" + value.replace(/'/g, "''") + "'";
  const launch = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath ${quote(helper)} -ArgumentList 'owner-broker ${id} ${sha}' -Verb RunAs -Wait`],
    { windowsHide: true, env: { SystemRoot: 'C:\\Windows' }, stdio: 'ignore' });
  const launchExit = once(launch, 'close').then(([code]) => code as number | null);
  let socket: Socket;
  try { socket = await withTimeout(Promise.race([connected, launchExit.then(() => { throw new SetupError('protection_unverified'); })]), 120000, 'system approval'); }
  catch { server.close(); throw new SetupError('protection_unverified'); }
  return { input: socket, output: socket, closing: async () => { socket.end(); server.close(); return withTimeout(launchExit, 30000, 'owner coordinator exit'); } };
}
main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('{"format_version":1,"error_code":"owner_setup_failed"}\n'); process.exitCode = 1;
});
