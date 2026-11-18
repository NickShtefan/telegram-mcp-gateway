/** Update one receipt-backed macOS installation. No Telegram, database or client-profile access. */
import { lstat, mkdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { acquireFileLease } from '../core/fileLease.js';
import { SetupError } from '../setup/contract.js';
import { readProtectedRootFile } from '../setup/installed.js';
import { attestManagedListener } from '../setup/listener.js';
import { stopPosixService, type StoppedService } from '../setup/serviceControl.js';
import { installLayout, serviceDefinition, type InstallLayout } from './platform.js';
import { agentCommand, ownerCommand, type PosixProvisionBackend } from './posixBackend.js';
import { attestAncestry, attestTree, syncDirectory, writeProtectedFile } from './posixPermissions.js';
import { provisionPlanSchema, receiptSchema, type ProvisionPlan, type ProvisionReceipt } from './provision.js';

const journalSchema = z.strictObject({
  format_version: z.literal(1), stagingId: z.uuid(), phase: z.enum(['staging', 'switching']), previous: receiptSchema, target: provisionPlanSchema,
  legacyOwner: z.boolean(), coreOnly: z.boolean(),
});
type Journal = z.infer<typeof journalSchema>;
type PreviousFormat = Pick<Journal, 'legacyOwner' | 'coreOnly'>;
const currentFormat: PreviousFormat = { legacyOwner: false, coreOnly: false };
const invalid = (): never => { throw new SetupError('invalid_state'); };
const denied = (): never => { throw new SetupError('protection_unverified'); };

function completed(receipt: ProvisionReceipt, target: ProvisionPlan): void {
  if (target.platform !== 'darwin' || receipt.identity?.kind !== 'posix' ||
      receipt.completed.join(',') !== 'identity,release,state,definition,commands' ||
      !isDeepStrictEqual({ ...receipt.plan, source_sha: target.source_sha }, target)) invalid();
}

function bindings(layout: InstallLayout, port: number, format: PreviousFormat) {
  const definition = serviceDefinition(layout, port);
  return [
    { path: layout.definition, mode: 0o644, text: format.coreOnly ? definition.replace('<string>--owner-toolsets</string>', '') : definition },
    { path: join(layout.prefix, 'bin', 'tg-mcp'), mode: 0o755, text: agentCommand(layout, port) },
    { path: join(layout.prefix, 'bin', 'tg-mcp-owner'), mode: 0o755, text: ownerCommand(layout, format.legacyOwner) },
  ];
}

async function readBinding(file: ReturnType<typeof bindings>[number]): Promise<string> {
  const bytes = await readProtectedRootFile(file.path, 16384);
  if (((await lstat(file.path)).mode & 0o7777) !== file.mode) denied();
  return bytes.toString('utf8');
}

async function previousFormat(layout: InstallLayout, port: number): Promise<PreviousFormat> {
  const current = bindings(layout, port, currentFormat);
  const legacy = bindings(layout, port, { legacyOwner: true, coreOnly: true });
  const data = await Promise.all(current.map(readBinding));
  if (data.some((value, i) => value !== current[i]!.text && value !== legacy[i]!.text)) denied();
  return { legacyOwner: data[2] === legacy[2]!.text, coreOnly: data[0] === legacy[0]!.text };
}

/** Each file must still be a known endpoint of this exact transaction, including during recovery. */
async function switchBindings(journal: Journal, forward: boolean): Promise<void> {
  const old = bindings(installLayout('darwin', journal.previous.plan.source_sha), journal.target.port, journal);
  const next = bindings(installLayout('darwin', journal.target.source_sha), journal.target.port, currentFormat);
  const changes = next.map((file, i) => ({ file, from: forward ? old[i]!.text : file.text, to: forward ? file.text : old[i]!.text }));
  const found = await Promise.all(changes.map(({ file }) => readBinding(file)));
  if (changes.some(({ from, to }, i) => found[i] !== from && found[i] !== to)) denied();
  for (const [i, { file, from, to }] of changes.entries()) {
    if (found[i] !== to) await writeProtectedFile(dirname(file.path), basename(file.path), Buffer.from(to), file.mode, { previous: Buffer.from(from) });
  }
}

async function optionalRecord(path: string): Promise<Buffer | null> {
  try { return await readProtectedRootFile(path, 16384); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}

async function discardScratch(releases: string, stagingId: string): Promise<string> {
  const temporary = join(releases, '.update-' + z.uuid().parse(stagingId));
  try { await lstat(temporary); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return temporary; throw err; }
  await attestAncestry(temporary);
  await attestTree(temporary);
  await rm(temporary, { recursive: true });
  await syncDirectory(releases);
  return temporary;
}

async function stageRelease(backend: PosixProvisionBackend, layout: InstallLayout, receipt: ProvisionReceipt, stagingId: string): Promise<void> {
  const releases = dirname(layout.release);
  await attestAncestry(releases);
  let exists = true;
  try { await lstat(layout.release); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; exists = false; }
  if (!exists) {
    // Publish a complete release in one rename. Interrupted staging never occupies the target SHA.
    const temporary = await discardScratch(releases, stagingId);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await backend.installRelease({ ...layout, release: temporary, application: join(temporary, 'application'), node: join(temporary, 'node') });
      await rename(temporary, layout.release);
      await syncDirectory(releases);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (!await backend.inspect({ ...receipt, completed: ['release'] }, layout, true)) denied();
}

interface UpdateOperations {
  receipt(): Promise<ProvisionReceipt>;
  journal(): Promise<Journal | null>;
  begin(journal: Journal, replaces?: Journal): Promise<void>;
  finish(): Promise<void>;
  inspectPrevious(receipt: ProvisionReceipt): Promise<PreviousFormat>;
  discardStaging(id: string): Promise<void>;
  stage(receipt: ProvisionReceipt, stagingId: string): Promise<void>;
  stop(journal: Journal): Promise<StoppedService>;
  switchBindings(journal: Journal, forward: boolean): Promise<void>;
  verify(receipt: ProvisionReceipt): Promise<void>;
  commit(receipt: ProvisionReceipt): Promise<void>;
  listener(receipt: ProvisionReceipt): Promise<void>;
}
export type UpdateOutcome = 'updated' | 'already_current';
export type UpdateStep = 'stage' | 'stop' | 'switch' | 'restore';

/** Caller holds both provisioning and owner-setup leases throughout this transaction. */
export async function applyMacUpdate(target: ProvisionPlan, ops: UpdateOperations, progress: (step: UpdateStep) => void): Promise<UpdateOutcome> {
  const saved = await ops.receipt();
  completed(saved, target);
  let journal = await ops.journal();
  let replaces: Journal | undefined;
  if (journal) {
    completed(journal.previous, target);
    if (!isDeepStrictEqual({ ...journal.target, source_sha: target.source_sha }, target) ||
        journal.previous.plan.source_sha === journal.target.source_sha ||
        !isDeepStrictEqual(saved.identity, journal.previous.identity) ||
        ![journal.target.source_sha, journal.previous.plan.source_sha].includes(saved.plan.source_sha)) invalid();
    if (journal.target.source_sha !== target.source_sha) {
      // After a failed activation, an explicitly selected signed repair can move forward.
      // Retain the original launchd marker. A partially switched, uncommitted target must finish first.
      if (target.source_sha === saved.plan.source_sha) invalid();
      if (isDeepStrictEqual(saved, journal.previous)) {
        // A failed repair can leave the prior daemon unhealthy after its files have already
        // been restored. Prove all active bindings before replacing the interrupted intent.
        const active = await ops.inspectPrevious(saved);
        if (active.coreOnly !== journal.coreOnly || active.legacyOwner !== journal.legacyOwner) denied();
        await ops.discardStaging(journal.stagingId);
      } else if (target.source_sha === journal.previous.plan.source_sha) invalid();
      replaces = journal;
      journal = null;
    }
  } else if (saved.plan.source_sha === target.source_sha) {
    await ops.verify(saved);
    return 'already_current';
  }

  const next = { ...saved, plan: target };
  progress('stage');
  if (!journal) {
    const format = await ops.inspectPrevious(saved);
    journal = { format_version: 1, stagingId: randomUUID(), phase: 'staging', previous: saved, target, ...format };
    await ops.begin(journal, replaces);
  }
  await ops.stage(next, journal.stagingId);
  if (journal.phase === 'staging') {
    const switching = { ...journal, phase: 'switching' as const };
    await ops.begin(switching, journal);
    journal = switching;
  }

  progress('stop');
  const service = await ops.stop(journal);
  const restore = (receipt: ProvisionReceipt) => service.restore(false, service.wasRunning ? () => ops.listener(receipt) : undefined);
  try {
    progress('switch');
    await ops.switchBindings(journal, true);
    await ops.verify(next);
    await ops.commit(next);
  } catch (err) {
    // After the new receipt commits, its daemon may have migrated SQLite. Recovery proceeds forward.
    if (isDeepStrictEqual(await ops.receipt(), journal.previous)) {
      await ops.switchBindings(journal, false);
      await restore(journal.previous);
      await ops.finish();
    }
    throw err;
  }
  progress('restore');
  await restore(next);
  await ops.finish();
  return 'updated';
}

export async function updateMacInstallation(target: ProvisionPlan, backend: PosixProvisionBackend, progress: (step: UpdateStep) => void): Promise<UpdateOutcome> {
  if (target.platform !== 'darwin' || process.platform !== 'darwin' || process.getuid?.() !== 0) denied();
  const layout = installLayout('darwin', target.source_sha);
  await attestAncestry(layout.prefix);
  await backend.attest(target, layout);
  return backend.withExclusive(async () => {
    const owner = await acquireFileLease(layout.prefix, 'owner.lock');
    const path = join(layout.prefix, 'update.json');
    try {
      if (await optionalRecord(join(layout.prefix, 'owner-service.json'))) invalid();
      const inspect = async (receipt: ProvisionReceipt): Promise<void> => {
        if (!await backend.inspect(receipt, layout, true)) denied();
      };
      return await applyMacUpdate(target, {
        receipt: async () => receiptSchema.parse(await backend.readReceipt()),
        journal: async () => {
          const raw = await optionalRecord(path);
          if (!raw && await optionalRecord(join(layout.prefix, 'update-service.json'))) invalid();
          return raw ? journalSchema.parse(JSON.parse(raw.toString('utf8'))) : null;
        },
        begin: async (journal, replaces) => {
          const previous = await optionalRecord(path);
          if (replaces ? !previous || !isDeepStrictEqual(journalSchema.parse(JSON.parse(previous.toString('utf8'))), replaces) : previous !== null) invalid();
          await writeProtectedFile(layout.prefix, 'update.json', Buffer.from(JSON.stringify(journal)), 0o600,
            previous ? { previous } : undefined);
        },
        discardStaging: async id => { await discardScratch(dirname(layout.release), id); },
        finish: async () => { await unlink(path); await syncDirectory(layout.prefix); },
        inspectPrevious: async receipt => {
          const old = installLayout('darwin', receipt.plan.source_sha);
          if (!await backend.inspect({ ...receipt, completed: ['identity', 'state'] }, old)) denied();
          await attestAncestry(old.release);
          const tree = await attestTree(old.release);
          if (!tree.get(old.node)?.isFile() || !tree.get(join(old.application, 'dist/cli/index.js'))?.isFile()) denied();
          return previousFormat(old, target.port);
        },
        stage: (receipt, id) => stageRelease(backend, layout, receipt, id),
        stop: journal => stopPosixService(layout, [installLayout('darwin', journal.previous.plan.source_sha).node, layout.node]),
        switchBindings, verify: inspect, commit: receipt => backend.saveReceipt(receipt),
        listener: receipt => {
          if (receipt.identity?.kind !== 'posix') return denied();
          return attestManagedListener(installLayout('darwin', receipt.plan.source_sha), receipt.identity.uid, receipt.plan.port);
        },
      }, progress);
    } finally { await owner.release(); }
  });
}
