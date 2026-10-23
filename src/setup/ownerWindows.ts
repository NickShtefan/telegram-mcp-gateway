/** Windows VSA owner worker: private on-demand mailbox, no network/admin endpoint. */
import { open, rename, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ownerPlanSchema, ownerSetup } from './owner.js';
import { coordinatorMessageSchema, questions } from './promptChannel.js';
import { installLayout } from '../install/platform.js';
import { acquireFileLease } from '../core/fileLease.js';
import { acquireLock } from '../core/lock.js';
import { readBoundedFile } from '../core/safeFs.js';
import { loadSessionSecret } from '../core/config.js';
import { openStorage } from '../storage/sqlite.js';
import { ApiCredentialFile } from './credentials.js';
import { setupIdSchema, SetupError } from './contract.js';
import { prepareOwnerClients } from './clientHandoff.js';
const run = promisify(execFile);
const planSchema = z.strictObject({ format_version: z.literal(1), source_sha: z.string().regex(/^[0-9a-f]{40}$/), legacy_setup_id: setupIdSchema.nullable().default(null), plan: ownerPlanSchema });
async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.argv.length !== 3) throw new SetupError('protection_unverified');
  const id = setupIdSchema.parse(process.argv[2]);
  const release = win32.dirname(process.execPath); const sha = win32.basename(release);
  const layout = installLayout('win32', sha);
  if (process.execPath.toLowerCase() !== layout.node.toLowerCase() || fileURLToPath(import.meta.url).toLowerCase() !== join(layout.application, 'dist/setup/ownerWindows.js').toLowerCase()) throw new SetupError('protection_unverified');
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const helper = join(layout.application, 'dist/setup/owner-protection.ps1');
  const attest = async (path: string): Promise<void> => {
    await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', path, '-RequireServiceIdentity'],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024, env: { SystemRoot: 'C:\\Windows' } });
  };
  const mailbox = join(layout.prefix, 'owner-setup');
  const read = async (path: string): Promise<string> =>
    (await readBoundedFile(path, { maximum: 2048, attest, fail: () => new SetupError('invalid_state') })).toString('utf8').replace(/^\uFEFF/, '');
  const plan = planSchema.parse(JSON.parse(await read(join(mailbox, 'plan.json'))));
  if (plan.source_sha !== sha || plan.plan.setup_id !== id) throw new SetupError('invalid_state');
  const write = async (name: string, value: unknown): Promise<void> => {
    await attest(mailbox); const temporary = join(mailbox, name + '.next');
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await attest(temporary); await rename(temporary, join(mailbox, name));
  };
  const config = z.object({ port: z.number().int().min(1).max(65535) }).parse(JSON.parse(await read(join(layout.prefix, 'service.json'))));
  let existingToken: string[] | null = null;
  try {
    existingToken = z.strictObject({ tokens: z.array(z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)).max(4) }).parse(JSON.parse(await read(join(mailbox, 'existing-credential.json')))).tokens;
    await unlink(join(mailbox, 'existing-credential.json'));
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const setup = await acquireFileLease(layout.state, 'setup.lock');
  try {
    const session = await acquireLock(layout.state);
    try {
      await attest(layout.state);
      const secret = loadSessionSecret(layout.state, {});
      const storage = openStorage(join(layout.state, 'gateway.sqlite')); let sequence = 0;
      try {
        let result = await ownerSetup(plan.plan, { authorize: () => attest(mailbox), withSetupLease: work => work(), withStoppedDaemon: work => work(),
          storage, sessionSecret: secret, credentials: new ApiCredentialFile(layout.state, () => attest(layout.state), attest),
          io: { out: () => { throw new SetupError('invalid_state'); }, err: () => undefined,
            prompt: async (question, options) => {
              const key = (Object.keys(questions) as Array<keyof typeof questions>).find(k => questions[k] === question);
              if (!key || !options?.hidden) throw new SetupError('invalid_state');
              const current = ++sequence; await write('request.json', { kind: 'prompt', sequence: current, question: key });
              const until = Date.now() + 300000;
              while (Date.now() < until) {
                try {
                  const answer = coordinatorMessageSchema.parse(JSON.parse(await read(join(mailbox, 'answer.json'))));
                  if (answer.kind !== 'answer' || answer.sequence !== current) throw new SetupError('invalid_state');
                  await unlink(join(mailbox, 'answer.json')); return answer.value;
                } catch (err) {
                  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              throw new SetupError('invalid_state');
            } } });
        const prepared=prepareOwnerClients(plan.plan,result,storage,secret,config.port,existingToken,plan.legacy_setup_id??undefined);
        result=prepared.result;if(prepared.message) await write('handoff.json',prepared.message);
        existingToken = null;
        await write('request.json', { kind: 'result', result });
        if (result.phase === 'failed') process.exitCode = 1;
      } finally { storage.close(); }
    } finally { await session.release(); }
  } finally { await setup.release(); }
}
main().catch(() => { process.exitCode = 1; });
