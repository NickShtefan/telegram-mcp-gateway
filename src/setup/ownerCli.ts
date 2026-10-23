/** Installed administrator terminal entry. Never exposed by the agent wrapper or MCP. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalIo } from '../cli/io.js';
import { attestServiceState, installedPosixProfile } from './installed.js';
import { stopPosixService } from './serviceControl.js';
import { attestDirectory } from '../install/posixPermissions.js';
import { acquireFileLease } from '../core/fileLease.js';
import { acquireLock } from '../core/lock.js';
import { loadSessionSecret } from '../core/config.js';
import { openStorage } from '../storage/sqlite.js';
import { ApiCredentialFile } from './credentials.js';
import { ownerSetup, ownerPlanSchema } from './owner.js';
import { coordinatorMessageSchema, privateExchange, privateLines, runPrivateProcess, sendPrivate, workerIo, workerMessageSchema, nextPrivate } from './promptChannel.js';
import { answerOwnerPrompt } from './presentation.js';
import { SetupError } from './contract.js';
import { prepareOwnerClients, acknowledgePreparedClients, ownerOperationId } from './clientHandoff.js';
import { withTimeout } from '../core/time.js';
import { attestManagedListener } from './listener.js';

async function main(): Promise<number> {
  const [mode, sha, ...extra] = process.argv.slice(2);
  if (!['terminal', 'worker', 'ack-worker', 'root-channel'].includes(mode ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '') || extra.length) throw new SetupError('invalid_request');
  // Every mode, including the root-started worker children, attests the whole installed profile before anything else.
  const { layout, receipt } = await installedPosixProfile(sha!);
  const entry = join(layout.application, 'dist/setup/ownerCli.js');
  if (fileURLToPath(import.meta.url) !== entry || process.execPath !== layout.node || receipt.identity?.kind !== 'posix') throw new SetupError('protection_unverified');
  const identity = receipt.identity;
  if (mode === 'ack-worker') {
    process.setgroups!([]); process.setgid!(identity.gid); process.setuid!(identity.uid); process.umask(0o077);
    const input = privateLines(process.stdin)[Symbol.asyncIterator]();
    const first = await withTimeout(input.next(),30000,'acknowledgement plan'); if(first.done) throw new SetupError('invalid_state');
    const message=coordinatorMessageSchema.parse(JSON.parse(first.value)); if(message.kind!=='plan') throw new SetupError('invalid_state');
    const second=await withTimeout(input.next(),30000,'client receipt'); if(second.done) throw new SetupError('invalid_state');
    const ack=coordinatorMessageSchema.parse(JSON.parse(second.value)); if(ack.kind!=='client_ack'||ack.setup_id!==message.plan.setup_id) throw new SetupError('invalid_state');
    await attestDirectory(layout.state,[identity.uid],0o077);
    const lease=await acquireFileLease(layout.state,'setup.lock');
    try {
      await attestServiceState(layout.state,identity.uid);
      const storage=openStorage(join(layout.state,'gateway.sqlite'));
      try { acknowledgePreparedClients(message.plan,storage,loadSessionSecret(layout.state,{}),ack.token_sha256,receipt.plan.setup_id); }
      finally { storage.close(); }
    } finally { await lease.release(); }
    return 0;
  }
  if (mode === 'worker') {
    // Drop supplementary administrator groups before dropping gid/uid.
    process.setgroups!([]); process.setgid!(identity.gid); process.setuid!(identity.uid); process.umask(0o077);
    const input = privateLines(process.stdin)[Symbol.asyncIterator]();
    const first = await input.next(); if (first.done) throw new SetupError('invalid_request');
    const message = coordinatorMessageSchema.parse(JSON.parse(first.value));
    if (message.kind !== 'plan') throw new SetupError('invalid_request');
    const setupLease = await acquireFileLease(layout.state, 'setup.lock');
    try {
      const sessionLease = await acquireLock(layout.state);
      try {
        const attestState = (): Promise<void> => attestServiceState(layout.state, identity.uid);
        await attestState();
        const secret = loadSessionSecret(layout.state, {});
        const storage = openStorage(join(layout.state, 'gateway.sqlite'));
        try {
          let result = await ownerSetup(message.plan, {
            authorize: async () => { if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid) throw new SetupError('protection_unverified'); },
            withSetupLease: work => work(), withStoppedDaemon: work => work(), storage,
            credentials: new ApiCredentialFile(layout.state, attestState), sessionSecret: secret, io: workerIo(input, process.stdout),
          });
          const prepared = prepareOwnerClients(message.plan,result,storage,secret,receipt.plan.port,(message.existing_tokens.length?message.existing_tokens:message.existing_token),receipt.plan.setup_id);
          result=prepared.result;if(prepared.message) await sendPrivate(process.stdout,prepared.message);
          await sendPrivate(process.stdout, { kind: 'result', result });
          return result.phase === 'failed' ? 1 : 0;
        } finally { storage.close(); }
      } finally { await sessionLease.release(); }
    } finally { await setupLease.release(); }
  }
  const channel = mode === 'root-channel';
  const parentInput = channel ? privateLines(process.stdin)[Symbol.asyncIterator]() : null;
  let plan; let existingToken: string | string[] | null = null;
  if (channel) {
    const uid = Number(process.env.SUDO_UID);
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid === identity.uid) throw new SetupError('protection_unverified');
    await sendPrivate(process.stdout, { kind: 'profile', setup_id: receipt.plan.setup_id, port: receipt.plan.port });
    const first = await withTimeout(parentInput!.next(), 300000, 'owner plan'); if (first.done) throw new SetupError('invalid_state');
    const message = coordinatorMessageSchema.parse(JSON.parse(first.value));
    if (message.kind !== 'plan' || message.plan.setup_id !== ownerOperationId(sha!, message.plan.user)) throw new SetupError('invalid_state');
    plan = message.plan; existingToken = message.existing_tokens.length?message.existing_tokens:message.existing_token;
  } else {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new SetupError('protection_unverified');
    terminalIo.err('Stop all agents and disable terminal capture/UI automation before continuing. Inputs are hidden, but same-user software is outside this protection.');
    if (await terminalIo.prompt('Type OWNER READY after completing those steps: ') !== 'OWNER READY') throw new SetupError('invalid_request');
    const account = await terminalIo.prompt('Gateway account id: '); const user = await terminalIo.prompt('Gateway user id: ');
    plan = ownerPlanSchema.parse({ setup_id: receipt.plan.setup_id, account, user, replace_session: false, rotate_token: false });
  }
  const rootLease = await acquireFileLease(layout.prefix, 'owner.lock');
  // A signal must not skip supervision restore: it kills live children and ends private input so the
  // structured cleanup below runs. A SIGKILLed coordinator leaves the protected restore marker instead.
  let interrupted = false; const children = new Set<ChildProcess>();
  const interrupt = (): void => { interrupted = true; for (const live of children) live.kill('SIGKILL'); if (channel) process.stdin.destroy(); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, interrupt);
  const supervised = <T extends ChildProcess>(child: T): T => { children.add(child); if (interrupted) child.kill('SIGKILL'); return child; };
  try {
    const stopped = await stopPosixService(layout);
    let activate = false;
    let completed: Extract<ReturnType<typeof workerMessageSchema.parse>, {kind:'result'}> | null=null;
    let pendingHandoff: Extract<ReturnType<typeof workerMessageSchema.parse>, {kind:'handoff'}> | null=null;
    let exitCode=1;
    try {
      const child = supervised(spawn(layout.node, [entry, 'worker', sha!], {
        cwd: layout.release, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TG_MCP_HOME: layout.state },
        stdio: ['pipe', 'pipe', 'ignore'], timeout: 15 * 60_000, killSignal: 'SIGKILL',
      }));
      // Start waiting immediately so an early worker failure cannot lose its exit event.
      const exited = once(child, 'close').then(([code]) => code as number | null);
      const inputLife = new AbortController();
      void exited.then(() => inputLife.abort(), () => inputLife.abort());
      // The worker's stdin ends with its final frame, so a pending worker read cannot outlive the exchange.
      const worker = privateExchange(child.stdout, child.stdin);
      let result: ReturnType<typeof workerMessageSchema.parse> | undefined;
      let sequence = 0;
      try {
        await sendPrivate(child.stdin, { kind: 'plan', plan, existing_tokens: Array.isArray(existingToken)?existingToken:existingToken?[existingToken]:[] });
        for await (const line of worker.frames) {
          const message = workerMessageSchema.parse(JSON.parse(line));
          if (result) throw new SetupError('invalid_state');
          if (message.kind === 'result') { result = message; worker.finish(); continue; }
          if (message.kind === 'handoff' && channel) {
            if(pendingHandoff||message.setup_id!==plan.setup_id||message.port!==receipt.plan.port||message.clients.join(',')!==plan.clients.join(',')) throw new SetupError('invalid_state');
            pendingHandoff=message;continue;
          }
          if (message.kind !== 'prompt') throw new SetupError('invalid_state');
          if (message.sequence !== ++sequence) throw new SetupError('invalid_state');
          if (channel) {
            await sendPrivate(process.stdout, message);
            const next = await nextPrivate(parentInput!, inputLife.signal); if (next.done) throw new SetupError('invalid_state');
            const answer = coordinatorMessageSchema.parse(JSON.parse(next.value));
            if (answer.kind !== 'answer' || answer.sequence !== sequence) throw new SetupError('invalid_state');
            await sendPrivate(child.stdin, answer);
          } else {
            const value = await answerOwnerPrompt(terminalIo, message.question, inputLife.signal);
            await sendPrivate(child.stdin, { kind: 'answer', sequence, value });
          }
        }
        const code = await exited;
        if (interrupted || result?.kind !== 'result' || result.result.setup_id !== plan.setup_id || (code === 0) !== (result.result.phase !== 'failed')) throw new SetupError('invalid_state');
        activate = result.result.phase === 'needs_service_start';
        completed=result;exitCode=code===0?0:1;
      } finally {
        worker.finish(); inputLife.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // Supervision is restored only after OS-confirmed worker termination.
        await exited;
      }
    } finally { await stopped.restore(activate); }
    if(activate) {
      await attestManagedListener(layout,identity.uid,receipt.plan.port);
      if(!channel||!pendingHandoff||interrupted) throw new SetupError('invalid_state');
      await sendPrivate(process.stdout,{...pendingHandoff,service_evidence:'listener_owned_by_service'});
      const next=await withTimeout(parentInput!.next(),300000,'client configuration'); if(next.done) throw new SetupError('invalid_state');
      const ack=coordinatorMessageSchema.parse(JSON.parse(next.value));
      if(ack.kind!=='client_ack'||ack.setup_id!==plan.setup_id) throw new SetupError('invalid_state');
      // The budget covers process start, the installed-profile check (one recursive release ACL listing) and state attestation.
      const child=supervised(spawn(layout.node,[entry,'ack-worker',sha!],{cwd:layout.release,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['pipe','ignore','ignore'],timeout:120000,killSignal:'SIGKILL'}));
      const exited=once(child,'close').then(([code])=>code as number|null);
      child.stdin.on('error',()=>undefined);
      try {await sendPrivate(child.stdin,{kind:'plan',plan});await sendPrivate(child.stdin,ack);child.stdin.end();if(await exited!==0) throw new SetupError('invalid_state');}
      finally {child.stdin.end();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
    }
    if(!completed||interrupted) throw new SetupError('invalid_state');
    if(channel) await sendPrivate(process.stdout,completed);else terminalIo.out(JSON.stringify(completed.result));
    return exitCode;
  } finally { for (const signal of signals) process.off(signal, interrupt); await rootLease.release(); }
}
// No stack, filesystem path, Telegram library text or private answer in output.
runPrivateProcess(main, 'owner_step_failed');
