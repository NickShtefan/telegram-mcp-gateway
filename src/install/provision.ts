/** Protected provisioning orchestration. Production operations require the platform backend. */
import { z } from 'zod';
import { installLayout, serviceDefinition, type InstallLayout } from './platform.js';
import type { InstallPlatform } from './manifest.js';
import { setupIdSchema, parseSafe, SetupError } from '../setup/contract.js';

export const provisionPlanSchema = z.strictObject({
  format_version: z.literal(1), setup_id: setupIdSchema,
  source_sha: z.string().regex(/^[0-9a-f]{40}$/), signer_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  platform: z.enum(['darwin', 'linux', 'win32']), port: z.number().int().min(1).max(65535),
});
export type ProvisionPlan = z.infer<typeof provisionPlanSchema>;
const identitySchema = z.union([
  z.strictObject({ kind: z.literal('posix'), uid: z.number().int().positive(), gid: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('windows'), sid: z.string().regex(/^S-1-5-80-(?:\d+-){4}\d+$/) }),
]);
export type ServiceIdentity = z.infer<typeof identitySchema>;
export const receiptSchema = z.strictObject({
  format_version: z.literal(1), plan: provisionPlanSchema,
  completed: z.array(z.enum(['identity', 'release', 'state', 'definition', 'commands'])),
  identity: identitySchema.nullable(),
}).superRefine((r, ctx) => {
  const ordered = ['identity', 'release', 'state', 'definition', 'commands'];
  if (r.completed.some((stage, i) => stage !== ordered[i]) || (r.completed.length === 0) !== (r.identity === null)
    || (r.identity !== null && (r.plan.platform === 'win32') !== (r.identity.kind === 'windows'))) {
    ctx.addIssue({ code: 'custom', message: 'invalid provision receipt' });
  }
});
export type ProvisionReceipt = z.infer<typeof receiptSchema>;
export interface ProvisionBackend {
  /** OS authorization, immutable verified code and exact independently trusted candidate. */
  attest(plan: ProvisionPlan, layout: InstallLayout): Promise<void>;
  withExclusive<T>(work: () => Promise<T>): Promise<T>;
  readReceipt(): Promise<unknown | null>;
  saveReceipt(receipt: ProvisionReceipt): Promise<void>;
  /** Reinspect completed stages; receipts alone cannot prove filesystem/service state. */
  inspect(receipt: ProvisionReceipt, layout: InstallLayout): Promise<boolean>;
  createIdentity(layout: InstallLayout): Promise<ServiceIdentity>;
  installRelease(layout: InstallLayout): Promise<void>;
  createState(layout: InstallLayout, identity: ServiceIdentity): Promise<void>;
  installDefinition(layout: InstallLayout, definition: string): Promise<void>;
  installCommands(layout: InstallLayout): Promise<void>;
}
export interface ProvisionResult {
  format_version: 1; setup_id: string;
  phase: 'needs_api_credentials' | 'failed'; error_code: 'protection_unverified' | 'invalid_state' | 'adapter_failed' | null;
  service_started: false;
}

/** There is no start/stop, arbitrary execution or secret input in this engine. */
export async function provision(plan: ProvisionPlan, backend: ProvisionBackend): Promise<ProvisionResult> {
  const p = parseSafe(provisionPlanSchema, plan, 'invalid_request');
  const result: ProvisionResult = { format_version: 1, setup_id: p.setup_id, phase: 'failed', error_code: 'adapter_failed', service_started: false };
  try {
    const layout = installLayout(p.platform as InstallPlatform, p.source_sha);
    await backend.attest(p, layout);
    return await backend.withExclusive(async () => {
      const raw = await backend.readReceipt();
      const saved = raw === null ? null : parseSafe(receiptSchema, raw);
      if (saved && JSON.stringify(saved.plan) !== JSON.stringify(p)) throw new SetupError('invalid_state');
      const receipt: ProvisionReceipt = saved ?? { format_version: 1, plan: p, completed: [], identity: null };
      if (saved && !await backend.inspect(saved, layout)) throw new SetupError('protection_unverified');
      const done = async (stage: ProvisionReceipt['completed'][number]): Promise<void> => {
        receipt.completed.push(stage); await backend.saveReceipt(receipt);
      };
      if (!receipt.completed.includes('identity')) {
        const identity = parseSafe(identitySchema, await backend.createIdentity(layout));
        if ((p.platform === 'win32') !== (identity.kind === 'windows')) throw new SetupError('invalid_state');
        receipt.identity = identity;
        await done('identity');
      }
      if (receipt.identity === null) throw new SetupError('invalid_state');
      if (!receipt.completed.includes('release')) { await backend.installRelease(layout); await done('release'); }
      if (!receipt.completed.includes('state')) { await backend.createState(layout, receipt.identity); await done('state'); }
      if (!receipt.completed.includes('definition')) { await backend.installDefinition(layout, serviceDefinition(layout, p.port)); await done('definition'); }
      if (!receipt.completed.includes('commands')) { await backend.installCommands(layout); await done('commands'); }
      if (!await backend.inspect(receipt, layout)) throw new SetupError('protection_unverified');
      return { ...result, phase: 'needs_api_credentials', error_code: null };
    });
  } catch (err) {
    if (err instanceof SetupError && (err.code === 'invalid_state' || err.code === 'protection_unverified')) result.error_code = err.code;
    return result;
  }
}
