/** Service-private token validation/receipt. Transport adapters never expose these messages as public status. */
import type { Storage } from '../storage/port.js';
import { sha256Hex } from '../core/crypto.js';
import { acknowledgeClientToken, pendingClientToken, type OwnerPlan, type OwnerResult } from './owner.js';
import { workerMessageSchema } from './promptChannel.js';
import { SetupError } from './contract.js';
/** Stable correlation per source/user; it grants no authority. */
export function ownerOperationId(sourceSha: string, user: string): string {
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(user)) throw new SetupError('invalid_request');
  const hash = sha256Hex(`telegram-gateway-owner:${sourceSha}:${user}`).slice(0, 32).split('');
  hash[12] = '4'; hash[16] = ['8', '9', 'a', 'b'][parseInt(hash[16]!, 16) & 3]!;
  const value = hash.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
/** A token is not consumed into profiles without the privileged listener proof. */
export function validatedClientHandoff(value: unknown, setupId: string, port: number, clients: OwnerPlan['clients']): string {
  const message = workerMessageSchema.parse(value);
  if (message.kind !== 'handoff' || message.setup_id !== setupId || message.port !== port || message.clients.join(',') !== clients.join(',')
    || message.service_evidence !== 'listener_owned_by_service') throw new SetupError('protection_unverified');
  return message.token;
}
export function prepareOwnerClients(plan: OwnerPlan, result: OwnerResult, storage: Storage, secret: string, port: number,
  existingToken: string | string[] | null, legacySetupId?: string): { result: OwnerResult; message: null | { kind: 'handoff'; setup_id: string; port: number; token: string; clients: OwnerPlan['clients'] } } {
  if (result.phase === 'failed' || !plan.clients.length) return { result, message: null };
  let pendingId = plan.setup_id; let pending = pendingClientToken(storage, pendingId, secret);
  if (!pending && legacySetupId) {
    const legacy = pendingClientToken(storage, legacySetupId, secret);
    if (legacy?.user === plan.user) { pending = legacy; pendingId = legacySetupId; }
  }
  const candidates=Array.isArray(existingToken)?existingToken:existingToken?[existingToken]:[];
  const token=pending?.user===plan.user?pending.token:candidates.find(value=>storage.users.get(plan.user)?.tokenSha256===sha256Hex(value))??null;
  if (!token || storage.users.get(plan.user)?.tokenSha256 !== sha256Hex(token)) return { result: { ...result, phase: 'needs_existing_client_credential' }, message: null };
  return { result: { ...result, phase: 'needs_service_start' }, message: { kind: 'handoff', setup_id: plan.setup_id, port, token, clients: plan.clients } };
}
/** DB-only acknowledgement: never constructs an MTProto client or takes daemon session ownership. */
export function acknowledgePreparedClients(plan: OwnerPlan, storage: Storage, secret: string, tokenHash: string, legacySetupId?: string): void {
  if (storage.users.get(plan.user)?.tokenSha256 !== tokenHash) throw new SetupError('invalid_state');
  let pendingId = plan.setup_id; let pending = pendingClientToken(storage, pendingId, secret);
  if (!pending && legacySetupId) { const legacy = pendingClientToken(storage, legacySetupId, secret); if (legacy?.user === plan.user) { pending = legacy; pendingId = legacySetupId; } }
  if (pending) {
    if (pending.user !== plan.user || sha256Hex(pending.token) !== tokenHash) throw new SetupError('invalid_state');
    acknowledgeClientToken(storage, pendingId, tokenHash);
  }
}
