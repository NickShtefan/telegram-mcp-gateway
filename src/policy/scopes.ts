/**
 * Access scopes: what the agent may read or write.
 *
 * Channels/groups are open by default (public and joined chats).
 * Private chats require individual owner `allow` rules or a global
 * private-chat mode (`send`: send-only; `open`: read/write).
 * Telegram service chats always remain closed because they contain login codes.
 */
import type { PeerKind } from '../core/chatId.js';
import { GatewayError } from '../core/errors.js';
import type { Storage } from '../storage/port.js';

/** Telegram login codes, BotFather, SpamBot, service notifications. */
const SERVICE_PEER_KEYS: ReadonlySet<string> = new Set(['777000', '93372553', '178220800', '42777']);
const SERVICE_USERNAMES: ReadonlySet<string> = new Set(['botfather', 'spambot', 'telegram', 'notoscam']);

export interface ScopeTarget {
  peerKey: string;
  kind: PeerKind;
  username?: string | null;
}

/** Denial reason: service chat, owner denial, or default-closed private chat. */
export type ScopeDenial = 'service' | 'deny' | 'private';

export type ScopeDecision = { allowed: true } | { allowed: false; code: ScopeDenial; reason: string };

/** Intended operation: read messages or prepare a write. */
export type ScopeAction = 'read' | 'write';

/**
 * User/account private-chat modes:
 * closed: only individually allowed chats are open (default);
 * send: draft messages to anyone, without reading conversations;
 * open: read and write any private chat.
 */
export type PrivateMode = 'closed' | 'send' | 'open';
export const PRIVATE_MODES: readonly PrivateMode[] = ['closed', 'send', 'open'];

/**
 * Store the mode as a scope rule with an internal target. Asterisks cannot
 * occur in usernames or chat keys, preventing confusion with real chat rules.
 */
const PRIVATE_MODE_TARGETS: Record<Exclude<PrivateMode, 'closed'>, string> = { send: '*private-send', open: '*private-open' };

export function isPrivateModeTarget(target: string): boolean {
  return target === PRIVATE_MODE_TARGETS.send || target === PRIVATE_MODE_TARGETS.open;
}

function modeOf(rules: Array<{ target: string }>): PrivateMode {
  if (rules.some(r => r.target === PRIVATE_MODE_TARGETS.open)) return 'open';
  if (rules.some(r => r.target === PRIVATE_MODE_TARGETS.send)) return 'send';
  return 'closed';
}

export function readPrivateMode(storage: Storage, userId: string, accountId: string): PrivateMode {
  return modeOf(storage.scopes.list(userId, accountId));
}

export function writePrivateMode(storage: Storage, userId: string, accountId: string, mode: PrivateMode): void {
  storage.transaction(() => {
    for (const target of Object.values(PRIVATE_MODE_TARGETS)) storage.scopes.remove(userId, accountId, target);
    if (mode !== 'closed') storage.scopes.put({ userId, accountId, target: PRIVATE_MODE_TARGETS[mode], effect: 'allow' });
  });
}

export class ScopePolicy {
  constructor(private readonly storage: Storage) {}

  privateMode(userId: string, accountId: string): PrivateMode {
    return readPrivateMode(this.storage, userId, accountId);
  }

  decide(userId: string, accountId: string, target: ScopeTarget, action: ScopeAction = 'read'): ScopeDecision {
    const username = target.username ? target.username.replace(/^@/, '').toLowerCase() : null;

    if (SERVICE_PEER_KEYS.has(target.peerKey) || (username !== null && SERVICE_USERNAMES.has(username))) {
      return { allowed: false, code: 'service', reason: 'Telegram service chats (login codes, BotFather, SpamBot) are never available through the gateway.' };
    }

    const all = this.storage.scopes.list(userId, accountId);
    const rules = all.filter(r => r.target === target.peerKey || (username !== null && r.target === username));
    if (rules.some(r => r.effect === 'deny')) {
      return { allowed: false, code: 'deny', reason: 'This chat is on the deny list set by the owner.' };
    }
    if (rules.some(r => r.effect === 'allow')) return { allowed: true };

    if (target.kind === 'user') {
      const mode = modeOf(all);
      if (mode === 'open' || (mode === 'send' && action === 'write')) return { allowed: true };
      return {
        allowed: false,
        code: 'private',
        reason:
          mode === 'send'
            ? 'Private chats are open for sending only: you can prepare a message with tg_send, but not read the conversation. The owner can open reading of one chat with: tg-mcp scope allow <user> <account> <chat>, or of all private chats with: tg-mcp scope private <user> <account> open.'
            : 'Private chats are closed by default. The owner can open one with: tg-mcp scope allow <user> <account> <chat>, or allow messages to any person with: tg-mcp scope private <user> <account> send.',
      };
    }
    return { allowed: true };
  }

  /** Throw ACCESS_DENIED when the chat is closed. */
  assertAllowed(userId: string, accountId: string, target: ScopeTarget, action: ScopeAction = 'read'): void {
    const decision = this.decide(userId, accountId, target, action);
    if (!decision.allowed) throw new GatewayError('ACCESS_DENIED', decision.reason);
  }

  isAllowed(userId: string, accountId: string, target: ScopeTarget, action: ScopeAction = 'read'): boolean {
    return this.decide(userId, accountId, target, action).allowed;
  }
}
