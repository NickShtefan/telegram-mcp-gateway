/**
 * Storage port for core and most service dependencies. SQLite-backed index,
 * snapshot and write stores also use the concrete database (`sqlite.ts`).
 * Methods are synchronous: SQLite
 * responds in-process, allowing atomic writes without asynchronous locks.
 *
 * All chat IDs here are keys from `core/chatId.ts` (marked IDs as strings).
 */
import type { Sealed } from '../core/crypto.js';
import type { PeerKind } from '../core/chatId.js';

// ---------- users and accounts (decision 16) ----------

export interface UserRecord {
  id: string;
  /** SHA-256 of the bearer token. The gateway does not store the token itself. */
  tokenSha256: string;
  defaultAccount: string | null;
  createdAt: number;
}

export type AccountStatus = 'needs_login' | 'active' | 'unauthorized';

export interface AccountRecord {
  id: string;
  /** The account's own Telegram ID, known after login. */
  tgUserId: string | null;
  username: string | null;
  displayName: string | null;
  status: AccountStatus;
  createdAt: number;
  updatedAt: number;
}

export interface UsersRepo {
  create(user: { id: string; tokenSha256: string; defaultAccount?: string | null }): UserRecord;
  get(id: string): UserRecord | null;
  findByTokenHash(tokenSha256: string): UserRecord | null;
  list(): UserRecord[];
  update(id: string, patch: { tokenSha256?: string; defaultAccount?: string | null }): void;
  remove(id: string): void;
}

export interface AccountsRepo {
  upsert(account: { id: string; tgUserId?: string | null; username?: string | null; displayName?: string | null; status?: AccountStatus }): AccountRecord;
  get(id: string): AccountRecord | null;
  list(): AccountRecord[];
  setStatus(id: string, status: AccountStatus): void;
  remove(id: string): void;
  grant(accountId: string, userId: string): void;
  revoke(accountId: string, userId: string): void;
  hasAccess(userId: string, accountId: string): boolean;
  accountsOf(userId: string): AccountRecord[];
  usersOf(accountId: string): string[];
}

export interface SessionsRepo {
  put(accountId: string, sealed: Sealed): void;
  get(accountId: string): Sealed | null;
}

// ---------- entity cache: accessHash belongs to an account ----------

export interface EntityRecord {
  accountId: string;
  peerKey: string;
  kind: PeerKind;
  /** accessHash as a string; basic groups have none. */
  accessHash: string | null;
  username: string | null;
  title: string | null;
  /** Forum, channel or supergroup, discussion group, and other metadata. */
  meta: Record<string, unknown>;
  updatedAt: number;
}

export interface EntitiesRepo {
  put(entity: Omit<EntityRecord, 'updatedAt'>): void;
  putMany(entities: Array<Omit<EntityRecord, 'updatedAt'>>): void;
  get(accountId: string, peerKey: string): EntityRecord | null;
  getByUsername(accountId: string, username: string): EntityRecord | null;
  remove(accountId: string, peerKey: string): void;
}

// ---------- audit ----------

export interface AuditEntry {
  id: number;
  ts: number;
  userId: string | null;
  accountId: string | null;
  tool: string;
  /** Call arguments without secrets. */
  args: Record<string, unknown>;
  peerKey: string | null;
  resultCount: number | null;
  durationMs: number;
  /** GatewayError code, or null on success. */
  errorCode: string | null;
  floodWaitSeconds: number | null;
}

export interface AuditRepo {
  add(entry: Omit<AuditEntry, 'id'>): number;
  recent(filter?: { userId?: string; accountId?: string; tool?: string; limit?: number }): AuditEntry[];
  prune(olderThanTs: number): number;
}

// ---------- jobs (long-running operations) ----------

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobRecord {
  id: string;
  userId: string;
  accountId: string | null;
  kind: string;
  params: Record<string, unknown>;
  state: JobState;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobsRepo {
  create(job: { id: string; userId: string; accountId?: string | null; kind: string; params: Record<string, unknown> }): JobRecord;
  get(id: string): JobRecord | null;
  update(id: string, patch: { state?: JobState; progress?: Record<string, unknown>; result?: Record<string, unknown> | null; error?: string | null }): void;
  /** Newest first by default; the queue uses oldestFirst. */
  list(filter?: { userId?: string; state?: JobState; limit?: number; oldestFirst?: boolean }): JobRecord[];
  /** Requeues all running jobs after a restart. */
  requeueRunning(): number;
}

// ---------- access scopes ----------

export type ScopeEffect = 'allow' | 'deny';

export interface ScopeRule {
  userId: string;
  accountId: string;
  /** Chat key, lowercase username without @, or internal private-chat mode target. */
  target: string;
  effect: ScopeEffect;
  createdAt: number;
}

/** Only the owner CLI sets rules; one rule per target. */
export interface ScopesRepo {
  put(rule: Omit<ScopeRule, 'createdAt'>): void;
  list(userId: string, accountId: string): ScopeRule[];
  remove(userId: string, accountId: string, target: string): number;
}

// ---------- key-value store for small state ----------

export interface KvRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Storage {
  users: UsersRepo;
  accounts: AccountsRepo;
  sessions: SessionsRepo;
  entities: EntitiesRepo;
  audit: AuditRepo;
  jobs: JobsRepo;
  scopes: ScopesRepo;
  kv: KvRepo;
  /** Runs fn in one transaction and rolls back on failure. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
