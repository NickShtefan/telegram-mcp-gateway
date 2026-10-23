/**
 * Resolves @username, t.me links, invites, and IDs to chats.
 *
 * Check the account entity cache before contacts.ResolveUsername,
 * which has strict rate limits. accessHash belongs to a session,
 * so each account has its own cache.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { parsePeerKey, peerKey as makePeerKey } from '../core/chatId.js';
import { entityFromApi, peerKeyOfPeer, toInputChannel, toInputUser } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { safeLabel } from '../policy/envelope.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { parseRef, type ChatTarget, type ParsedRef } from './links.js';

export type ChatType = 'channel' | 'supergroup' | 'forum' | 'group' | 'user' | 'bot';

export interface ChatCard {
  peerKey: string;
  type: ChatType;
  title: string | null;
  username: string | null;
  about: string | null;
  members: number | null;
  /** Account membership, or null when Telegram does not report it. */
  isMember: boolean | null;
  verified: boolean;
  scam: boolean;
  /** Channel discussion group, or the channel linked to a group. */
  linkedChatKey: string | null;
  /** Whether a channel has a discussion group and post comments. */
  commentsEnabled: boolean | null;
  slowmodeSeconds: number | null;
  link: string | null;
}

export interface InviteCard {
  /** Existing membership allows the account to read the chat. */
  member: boolean;
  /** Chat when accessible through membership or preview. */
  chat: EntityRecord | null;
  title: string | null;
  about: string | null;
  members: number | null;
  type: ChatType | null;
  /** Join requests require approval by a chat administrator. */
  requestNeeded: boolean;
}

/** Time until cached usernames are revalidated through Telegram. */
const USERNAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function chatTypeOf(entity: Pick<EntityRecord, 'kind' | 'meta'>): ChatType {
  if (entity.kind === 'user') return entity.meta.bot === true ? 'bot' : 'user';
  if (entity.kind === 'chat') return 'group';
  if (entity.meta.forum === true) return 'forum';
  if (entity.meta.broadcast === true) return 'channel';
  return 'supergroup';
}

export interface ResolverDeps {
  tg: Tg;
  entities: EntitiesRepo;
  now?: () => number;
}

export class Resolver {
  private readonly tg: Tg;
  private readonly entities: EntitiesRepo;
  private readonly now: () => number;

  constructor(deps: ResolverDeps) {
    this.tg = deps.tg;
    this.entities = deps.entities;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Parses references and resolves chats; invite chats require existing membership. */
  async resolve(accountId: string, ref: string, options?: TgCallOptions): Promise<{ parsed: ParsedRef; chat: EntityRecord }> {
    const parsed = parseRef(ref);
    return { parsed, chat: await this.chat(accountId, parsed.chat, options) };
  }

  async chat(accountId: string, target: ChatTarget, options?: TgCallOptions): Promise<EntityRecord> {
    switch (target.type) {
      case 'username':
        return this.byUsername(accountId, target.username, options);
      case 'peer':
        return this.byKey(accountId, target.peerKey);
      case 'invite': {
        const invite = await this.invite(accountId, target.hash, options);
        if (!invite.chat) {
          throw new GatewayError(
            'JOIN_REQUIRED',
            `This is a private chat "${safeLabel(invite.title, 60) || 'unknown'}" and the account is not a member. Joining goes through tg_join with the owner's confirmation.`,
          );
        }
        return invite.chat;
      }
    }
  }

  async byUsername(accountId: string, username: string, options?: TgCallOptions): Promise<EntityRecord> {
    const clean = username.replace(/^@/, '');
    const cached = this.entities.getByUsername(accountId, clean);
    if (cached && this.usable(cached) && this.now() - cached.updatedAt < USERNAME_TTL_MS) return cached;

    const result = await this.tg.invoke(accountId, new Api.contacts.ResolveUsername({ username: clean }), options);
    const key = peerKeyOfPeer((result as { peer?: unknown }).peer);
    const entity = key ? this.entities.get(accountId, key) : null;
    if (!entity) {
      throw new GatewayError('CHAT_NOT_FOUND', `Nothing found by username @${clean}.`);
    }
    return entity;
  }

  /** Resolves keys from cache only; Telegram requires the cached accessHash. */
  byKey(accountId: string, key: string): EntityRecord {
    const cached = this.entities.get(accountId, key);
    if (cached && this.usable(cached)) return cached;
    const ref = parsePeerKey(key);
    if (ref.kind === 'chat') {
      // Basic groups do not need accessHash.
      return { accountId, peerKey: key, kind: 'chat', accessHash: null, username: null, title: null, meta: {}, updatedAt: this.now() };
    }
    throw new GatewayError(
      'CHAT_NOT_FOUND',
      `Chat ${key} is not known to this account yet. Pass its @username or t.me link instead, or find it through search first.`,
    );
  }

  /** Forgets stale chat entries after CHAT_NOT_FOUND. */
  forget(accountId: string, key: string): void {
    this.entities.remove(accountId, key);
  }

  async invite(accountId: string, hash: string, options?: TgCallOptions): Promise<InviteCard> {
    const result = (await this.tg.invoke(accountId, new Api.messages.CheckChatInvite({ hash }), options)) as unknown as {
      className?: string;
      chat?: unknown;
      title?: string;
      about?: string;
      participantsCount?: number;
      broadcast?: boolean;
      megagroup?: boolean;
      requestNeeded?: boolean;
    };

    if (result.className === 'ChatInviteAlready' || result.className === 'ChatInvitePeek') {
      const info = entityFromApi(result.chat);
      const chat = info ? this.entities.get(accountId, info.peerKey) : null;
      return {
        member: result.className === 'ChatInviteAlready',
        chat,
        title: info?.title ?? null,
        about: null,
        members: typeof info?.meta.participants === 'number' ? info.meta.participants : null,
        type: chat ? chatTypeOf(chat) : null,
        requestNeeded: false,
      };
    }

    return {
      member: false,
      chat: null,
      title: result.title ?? null,
      about: result.about ?? null,
      members: result.participantsCount ?? null,
      type: result.broadcast ? 'channel' : result.megagroup ? 'supergroup' : 'group',
      requestNeeded: result.requestNeeded === true,
    };
  }

  /** Chat profile: description, participants, discussion group, and membership. */
  async card(accountId: string, entity: EntityRecord, options?: TgCallOptions): Promise<ChatCard> {
    const base: ChatCard = {
      peerKey: entity.peerKey,
      type: chatTypeOf(entity),
      title: entity.title,
      username: entity.username,
      about: null,
      members: null,
      isMember: null,
      verified: entity.meta.verified === true,
      scam: entity.meta.scam === true,
      linkedChatKey: null,
      commentsEnabled: null,
      slowmodeSeconds: null,
      link: entity.username ? `https://t.me/${entity.username}` : null,
    };

    try {
      if (entity.kind === 'channel') {
        const result = (await this.tg.invoke(
          accountId,
          new Api.channels.GetFullChannel({ channel: toInputChannel(entity) }),
          options,
        )) as unknown as { fullChat?: { about?: string; participantsCount?: number; linkedChatId?: unknown; slowmodeSeconds?: number } };
        // GetFullChannel also returns updated channel flags; reread the cache.
        const fresh = this.entities.get(accountId, entity.peerKey) ?? entity;
        const linked = result.fullChat?.linkedChatId;
        const linkedKey = linked !== undefined && linked !== null ? makePeerKey({ kind: 'channel', id: BigInt(String(linked)) }) : null;
        const type = chatTypeOf(fresh);
        return {
          ...base,
          type,
          title: fresh.title,
          username: fresh.username,
          about: result.fullChat?.about || null,
          members: result.fullChat?.participantsCount ?? (typeof fresh.meta.participants === 'number' ? fresh.meta.participants : null),
          isMember: typeof fresh.meta.member === 'boolean' ? fresh.meta.member : null,
          verified: fresh.meta.verified === true,
          scam: fresh.meta.scam === true,
          linkedChatKey: linkedKey,
          commentsEnabled: type === 'channel' ? linkedKey !== null : null,
          slowmodeSeconds: result.fullChat?.slowmodeSeconds ?? null,
          link: fresh.username ? `https://t.me/${fresh.username}` : null,
        };
      }

      if (entity.kind === 'chat') {
        const ref = parsePeerKey(entity.peerKey);
        const result = (await this.tg.invoke(
          accountId,
          new Api.messages.GetFullChat({ chatId: bigInt(ref.id.toString()) }),
          options,
        )) as unknown as { fullChat?: { about?: string } };
        const fresh = this.entities.get(accountId, entity.peerKey) ?? entity;
        return {
          ...base,
          title: fresh.title,
          about: result.fullChat?.about || null,
          members: typeof fresh.meta.participants === 'number' ? fresh.meta.participants : null,
          isMember: fresh.meta.forbidden === true ? false : true,
        };
      }

      const result = (await this.tg.invoke(
        accountId,
        new Api.users.GetFullUser({ id: toInputUser(entity) }),
        options,
      )) as unknown as { fullUser?: { about?: string } };
      return { ...base, about: result.fullUser?.about || null };
    } catch (err) {
      if (isGatewayError(err, 'CHAT_NOT_FOUND')) this.forget(accountId, entity.peerKey);
      throw err;
    }
  }

  private usable(entity: EntityRecord): boolean {
    return entity.kind === 'chat' || entity.accessHash !== null;
  }
}
