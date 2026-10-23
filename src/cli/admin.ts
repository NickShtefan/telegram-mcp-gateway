/**
 * Gateway user/account management (decision 16). Pure storage functions;
 * CLI commands only parse arguments and print results.
 */
import { randomToken, sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import { isPrivateModeTarget, PRIVATE_MODES, readPrivateMode, writePrivateMode, type PrivateMode } from '../policy/scopes.js';
import { parseRef } from '../services/links.js';
import type { AccountRecord, ScopeEffect, ScopeRule, Storage, UserRecord } from '../storage/port.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function assertId(kind: 'user' | 'account', id: string): string {
  if (!ID_RE.test(id)) {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Invalid ${kind} id "${id}": use 1-32 characters, lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  return id;
}

export interface NewUser {
  user: UserRecord;
  /** Show tokens only once; the gateway stores only their hashes. */
  token: string;
}

export function addUser(
  storage: Storage,
  input: { id: string; accounts?: string[]; defaultAccount?: string | null },
): NewUser {
  const id = assertId('user', input.id);
  if (storage.users.get(id)) {
    throw new GatewayError('INVALID_ARGUMENT', `User "${id}" already exists.`);
  }
  const accounts = (input.accounts ?? []).map(a => assertId('account', a));
  const defaultAccount = input.defaultAccount ?? accounts[0] ?? null;
  if (defaultAccount !== null && !accounts.includes(defaultAccount)) accounts.push(assertId('account', defaultAccount));

  const token = randomToken(32);
  return storage.transaction(() => {
    const user = storage.users.create({ id, tokenSha256: sha256Hex(token), defaultAccount });
    for (const accountId of accounts) {
      if (!storage.accounts.get(accountId)) storage.accounts.upsert({ id: accountId });
      storage.accounts.grant(accountId, id);
    }
    return { user, token };
  });
}

/** Issue a new token and immediately revoke the old one. */
export function rotateToken(storage: Storage, userId: string): string {
  if (!storage.users.get(userId)) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  const token = randomToken(32);
  storage.users.update(userId, { tokenSha256: sha256Hex(token) });
  return token;
}

export function removeUser(storage: Storage, userId: string): void {
  if (!storage.users.get(userId)) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  storage.users.remove(userId);
}

export function grantAccount(storage: Storage, accountId: string, userId: string): void {
  assertId('account', accountId);
  const user = storage.users.get(userId);
  if (!user) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  storage.transaction(() => {
    if (!storage.accounts.get(accountId)) storage.accounts.upsert({ id: accountId });
    storage.accounts.grant(accountId, userId);
    if (user.defaultAccount === null) storage.users.update(userId, { defaultAccount: accountId });
  });
}

export function revokeAccount(storage: Storage, accountId: string, userId: string): void {
  const user = storage.users.get(userId);
  if (!user) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  storage.transaction(() => {
    storage.accounts.revoke(accountId, userId);
    if (user.defaultAccount === accountId) {
      const rest = storage.accounts.accountsOf(userId);
      storage.users.update(userId, { defaultAccount: rest[0]?.id ?? null });
    }
  });
}

export function setDefaultAccount(storage: Storage, userId: string, accountId: string): void {
  if (!storage.users.get(userId)) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  if (!storage.accounts.hasAccess(userId, accountId)) {
    throw new GatewayError('ACCESS_DENIED', `User "${userId}" has no access to account "${accountId}". Grant it first.`);
  }
  storage.users.update(userId, { defaultAccount: accountId });
}

export function removeAccount(storage: Storage, accountId: string): void {
  if (!storage.accounts.get(accountId)) throw new GatewayError('NOT_FOUND', `Account "${accountId}" does not exist.`);
  storage.transaction(() => {
    for (const user of storage.users.list()) {
      if (user.defaultAccount === accountId) {
        const rest = storage.accounts.accountsOf(user.id).filter(a => a.id !== accountId);
        storage.users.update(user.id, { defaultAccount: rest[0]?.id ?? null });
      }
    }
    storage.accounts.remove(accountId);
  });
}

export interface UserView {
  id: string;
  defaultAccount: string | null;
  accounts: string[];
}

export function describeUsers(storage: Storage): UserView[] {
  return storage.users.list().map(u => ({
    id: u.id,
    defaultAccount: u.defaultAccount,
    accounts: storage.accounts.accountsOf(u.id).map(a => a.id),
  }));
}

export interface AccountView {
  id: string;
  status: AccountRecord['status'];
  username: string | null;
  displayName: string | null;
  hasSession: boolean;
  users: string[];
  /** Shared account: accessible to multiple users (decision 18). */
  shared: boolean;
}

export function describeAccounts(storage: Storage): AccountView[] {
  return storage.accounts.list().map(a => {
    const users = storage.accounts.usersOf(a.id);
    return {
      id: a.id,
      status: a.status,
      username: a.username,
      displayName: a.displayName,
      hasSession: storage.sessions.get(a.id) !== null,
      users,
      shared: users.length > 1,
    };
  });
}

/** Scope target: lowercase username without @, or a chat key. */
function scopeTarget(chat: string): string {
  const parsed = parseRef(chat);
  if (parsed.chat.type === 'username') return parsed.chat.username.toLowerCase();
  if (parsed.chat.type === 'peer') return parsed.chat.peerKey;
  throw new GatewayError('INVALID_ARGUMENT', 'A scope rule needs a @username or a numeric chat id, not an invite link.');
}

function assertUserAccount(storage: Storage, userId: string, accountId: string): void {
  if (!storage.users.get(userId)) throw new GatewayError('NOT_FOUND', `User "${userId}" does not exist.`);
  if (!storage.accounts.hasAccess(userId, accountId)) {
    throw new GatewayError('ACCESS_DENIED', `User "${userId}" has no access to account "${accountId}".`);
  }
}

/**
 * Allow or deny a chat for a user/account.
 * Private conversations remain closed until the owner explicitly grants access.
 */
export function setScope(storage: Storage, userId: string, accountId: string, chat: string, effect: ScopeEffect): string {
  assertUserAccount(storage, userId, accountId);
  const target = scopeTarget(chat);
  storage.scopes.put({ userId, accountId, target, effect });
  return target;
}

export function removeScope(storage: Storage, userId: string, accountId: string, chat: string): number {
  assertUserAccount(storage, userId, accountId);
  return storage.scopes.remove(userId, accountId, scopeTarget(chat));
}

/** Chat rules excluding the internal private-mode record. */
export function listScopes(storage: Storage, userId: string, accountId: string): ScopeRule[] {
  assertUserAccount(storage, userId, accountId);
  return storage.scopes.list(userId, accountId).filter(r => !isPrivateModeTarget(r.target));
}

export function getPrivateMode(storage: Storage, userId: string, accountId: string): PrivateMode {
  assertUserAccount(storage, userId, accountId);
  return readPrivateMode(storage, userId, accountId);
}

/** Private-chat mode: closed, send-only, or open for read/write. */
export function setPrivateMode(storage: Storage, userId: string, accountId: string, mode: string): PrivateMode {
  assertUserAccount(storage, userId, accountId);
  if (!(PRIVATE_MODES as readonly string[]).includes(mode)) {
    throw new GatewayError('INVALID_ARGUMENT', `Unknown private chat mode "${mode}". Use one of: ${PRIVATE_MODES.join(', ')}.`);
  }
  writePrivateMode(storage, userId, accountId, mode as PrivateMode);
  return mode as PrivateMode;
}
