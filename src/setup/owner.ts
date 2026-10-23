/** Secret-bearing service worker core. Only the authorized human coordinator calls this API. */
import { z } from 'zod';
import type { Storage } from '../storage/port.js';
import type { CliIo } from '../cli/io.js';
import { loginAccount } from '../core/auth.js';
import { defaultClientFactory, type ClientFactory } from '../core/clientPool.js';
import { createLogger } from '../core/log.js';
import { randomToken, seal, sha256Hex, unseal, type Sealed } from '../core/crypto.js';
import { addUser, grantAccount } from '../cli/admin.js';
import { parseSafe, setupIdSchema, SetupError } from './contract.js';

/** Local account and user labels; the wizard explains this rule before the plan is built. */
export const ownerLabelPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const id = z.string().regex(ownerLabelPattern);
export const ownerPlanSchema = z.strictObject({ setup_id: setupIdSchema, account: id, user: id,
  replace_session: z.boolean().default(false), rotate_token: z.boolean().default(false),
  clients: z.array(z.enum(['codex', 'claude', 'opencode', 'hermes'])).max(4).default([]),
}).refine(p => new Set(p.clients).size === p.clients.length);
export type OwnerPlan = z.infer<typeof ownerPlanSchema>;
export interface ApiCredentials { apiId: number; apiHash: string; }
const apiSchema = z.strictObject({ apiId: z.number().int().positive(), apiHash: z.string().regex(/^[0-9a-f]{32}$/) });
export interface OwnerWorkerDeps {
  /** Real owner OS approval, service identity and paused-agent terminal conditions. */
  authorize(plan: OwnerPlan): Promise<void>;
  /** Freeze/stop supervisor, prove old process exit, then acquire the session lease. */
  withStoppedDaemon<T>(work: () => Promise<T>): Promise<T>;
  withSetupLease<T>(work: () => Promise<T>): Promise<T>;
  credentials: { read(): Promise<ApiCredentials | null>; write(value: ApiCredentials): Promise<void>; };
  storage: Storage; io: CliIo; sessionSecret: string; factory?: ClientFactory;
  onFatal?: () => never;
}
export interface OwnerResult { format_version: 1; setup_id: string;
  phase: 'needs_client_configuration' | 'needs_existing_client_credential' | 'needs_service_start' | 'failed';
  error_code: 'invalid_owner_input' | 'owner_step_failed' | null; }
const pendingSchema = z.strictObject({ user: id, sealed: z.strictObject({ data: z.string().regex(/^[0-9a-f]{2,512}:[0-9a-f]{32}$/), iv: z.string().regex(/^[0-9a-f]{24}$/) }) });
function pendingKey(setupId: string): string { return `setup.handoff.${setupId}`; }

export async function ownerSetup(plan: OwnerPlan, deps: OwnerWorkerDeps): Promise<OwnerResult> {
  const p = parseSafe(ownerPlanSchema, plan, 'invalid_request');
  const result: OwnerResult = { format_version: 1, setup_id: p.setup_id, phase: 'failed', error_code: 'owner_step_failed' };
  try {
    await deps.authorize(p);
    return await deps.withSetupLease(() => deps.withStoppedDaemon(async () => {
      const existingPending = pendingClientToken(deps.storage, p.setup_id, deps.sessionSecret);
      if (existingPending && existingPending.user !== p.user) throw new SetupError('invalid_state');
      let credentials = await deps.credentials.read();
      const newCredentials = credentials === null;
      const login = !deps.storage.sessions.get(p.account) || p.replace_session;
      // Existing sessions with a missing API file require explicit repair; refuse before asking for secrets.
      if (newCredentials && !login) throw new SetupError('invalid_state');
      if (credentials === null) {
        // The original-user launcher shows the API application guidance when this fixed question arrives.
        const apiId = await deps.io.prompt('Telegram application id: ', { hidden: true });
        const apiHash = (await deps.io.prompt('Telegram application hash: ', { hidden: true })).trim();
        credentials = parseSafe(apiSchema, { apiId: Number(apiId), apiHash }, 'invalid_request');
      } else credentials = parseSafe(apiSchema, credentials, 'invalid_state');
      const api = credentials;
      if (login) {
        const phone = await deps.io.prompt('Telegram phone (international format): ', { hidden: true });
        await loginAccount({
          factory: deps.factory ?? defaultClientFactory, ...api, phone, accountId: p.account,
          prompts: { code: () => deps.io.prompt('Telegram verification code: ', { hidden: true }),
            password: () => deps.io.prompt('Telegram two-factor password: ', { hidden: true }) },
          log: createLogger('owner-login', { level: 'silent' }), onFatal: deps.onFatal,
          // Runs only after authorization and before client cleanup, which may terminate this worker.
          // Do not cache a mistyped API pair on failed/canceled first login.
          persist: async logged => {
            if (newCredentials) await deps.credentials.write(api);
            deps.storage.transaction(() => {
              deps.storage.accounts.upsert({ id: p.account, ...logged.identity, status: 'active' });
              deps.storage.sessions.put(p.account, seal(logged.session, deps.sessionSecret));
            });
          },
        });
      }
      let pending = deps.storage.kv.get(pendingKey(p.setup_id));
      const user = deps.storage.users.get(p.user);
      deps.storage.transaction(() => {
        if (!user) {
          const created = addUser(deps.storage, { id: p.user, accounts: [p.account], defaultAccount: p.account });
          pending = JSON.stringify({ user: p.user, sealed: seal(created.token, deps.sessionSecret) });
          deps.storage.kv.set(pendingKey(p.setup_id), pending!);
        } else {
          grantAccount(deps.storage, p.account, p.user);
          if (p.rotate_token) {
            // Only an explicitly owner-approved plan may revoke the old token.
            const token = randomToken(32);
            deps.storage.users.update(p.user, { tokenSha256: sha256Hex(token) });
            pending = JSON.stringify({ user: p.user, sealed: seal(token, deps.sessionSecret) });
            deps.storage.kv.set(pendingKey(p.setup_id), pending!);
          }
        }
      });
      if (pending) {
        const handoff = pendingClientToken(deps.storage, p.setup_id, deps.sessionSecret);
        if (!handoff || handoff.user !== p.user) throw new SetupError('invalid_state');
      }
      return { ...result, phase: pending ? 'needs_client_configuration' : 'needs_existing_client_credential', error_code: null };
    }));
  } catch (err) {
    if (err instanceof SetupError && err.code === 'invalid_request') result.error_code = 'invalid_owner_input';
    return result;
  }
}
/** Authorized service-to-client handoff only; the returned token must never reach public progress/stdio. */
export function pendingClientToken(storage: Storage, setupId: string, secret: string): { user: string; token: string } | null {
  parseSafe(setupIdSchema, setupId, 'invalid_request');
  const raw = storage.kv.get(pendingKey(setupId)); if (!raw) return null;
  let pending: { user: string; sealed: Sealed };
  try { pending = parseSafe(pendingSchema, JSON.parse(raw)); } catch { throw new SetupError('invalid_state'); }
  let token: string;
  try { token = unseal(pending.sealed, secret); } catch { throw new SetupError('invalid_state'); }
  if (storage.users.get(pending.user)?.tokenSha256 !== sha256Hex(token)) throw new SetupError('invalid_state');
  return { user: pending.user, token };
}
export function acknowledgeClientToken(storage: Storage, setupId: string, tokenHash: string): void {
  parseSafe(setupIdSchema, setupId, 'invalid_request');
  const raw = storage.kv.get(pendingKey(setupId)); if (!raw) return;
  const pending = parseSafe(pendingSchema, JSON.parse(raw));
  if (storage.users.get(pending.user)?.tokenSha256 !== tokenHash) throw new SetupError('invalid_state');
  storage.kv.set(pendingKey(setupId), '');
}
