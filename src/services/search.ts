/**
 * Message search across account chats, by hashtag in public posts, and
 * within individual chats.
 *
 * Global search positions use offsetRate, offsetPeer, and offsetId.
 * Results contain actual messages rather than only their chats.
 *
 * messages.SearchGlobal searches account chats (channels, groups, or private conversations);
 * channels.SearchPosts is used only for hashtag searches.
 * There is no Telegram-wide full-text search here.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { AccountIdentity } from '../core/clientPool.js';
import { toInputPeer } from '../core/entities.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { PAGE_MAX } from './history.js';
import { normalizeMessages, totalCount, type MessageDto } from './messages.js';

export interface GlobalPosition {
  offsetRate: number;
  offsetPeerKey: string;
  offsetId: number;
}

export interface GlobalSearchParams {
  query: string;
  limit: number;
  minDate?: number;
  maxDate?: number;
  /**
   * Search channels, groups, or private chats. Tools check scopes before
   * returning private results and discard closed conversations.
   */
  where: 'channels' | 'groups' | 'private';
  position?: GlobalPosition;
}

export interface GlobalSearchPage {
  messages: MessageDto[];
  next: GlobalPosition | null;
}

export interface ChatSearchParams {
  query: string;
  limit: number;
  offsetId?: number;
  minDate?: number;
  maxDate?: number;
  /** Filter to messages from this author. */
  from?: EntityRecord;
  topicId?: number;
}

export interface ChatSearchPage {
  messages: MessageDto[];
  raw: unknown[];
  total: number | null;
  nextOffsetId: number | null;
}

interface SliceLike {
  nextRate?: number;
  messages?: unknown[];
}

export class SearchService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
  ) {}

  async global(accountId: string, params: GlobalSearchParams, options?: TgCallOptions): Promise<GlobalSearchPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.messages.SearchGlobal({
        q: params.query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: params.minDate ?? 0,
        maxDate: params.maxDate ?? 0,
        offsetRate: params.position?.offsetRate ?? 0,
        offsetPeer: this.offsetPeer(accountId, params.position),
        offsetId: params.position?.offsetId ?? 0,
        limit,
        broadcastsOnly: params.where === 'channels' ? true : undefined,
        groupsOnly: params.where === 'groups' ? true : undefined,
        usersOnly: params.where === 'private' ? true : undefined,
      }),
      options,
    );
    // Outgoing private messages omit authors and are attributed to the account.
    return this.globalPage(result, params.where === 'private' ? await this.tg.whoami(accountId) : undefined);
  }

  /** Searches hashtags in public channel posts. */
  async hashtag(accountId: string, hashtag: string, limit: number, position?: GlobalPosition, options?: TgCallOptions): Promise<GlobalSearchPage> {
    const capped = Math.min(Math.max(1, limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.channels.SearchPosts({
        hashtag: hashtag.replace(/^#/, ''),
        offsetRate: position?.offsetRate ?? 0,
        offsetPeer: this.offsetPeer(accountId, position),
        offsetId: position?.offsetId ?? 0,
        limit: capped,
      }),
      options,
    );
    return this.globalPage(result);
  }

  async inChat(accountId: string, chat: EntityRecord, params: ChatSearchParams, options?: TgCallOptions): Promise<ChatSearchPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.messages.Search({
        peer: toInputPeer(chat),
        q: params.query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: params.minDate ?? 0,
        maxDate: params.maxDate ?? 0,
        offsetId: params.offsetId ?? 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
        fromId: params.from ? toInputPeer(params.from) : undefined,
        topMsgId: params.topicId,
      }),
      options,
    );
    const raw = Array.isArray((result as SliceLike).messages) ? ((result as SliceLike).messages as unknown[]) : [];
    // Private outgoing results omit fromId and are attributed to the account.
    const self = chat.kind === 'user' ? await this.tg.whoami(accountId) : undefined;
    const messages = normalizeMessages(result, chat.peerKey, self);
    const last = raw[raw.length - 1] as { id?: number } | undefined;
    return {
      messages,
      raw,
      total: totalCount(result),
      nextOffsetId: raw.length < limit || typeof last?.id !== 'number' ? null : last.id,
    };
  }

  private offsetPeer(accountId: string, position?: GlobalPosition): Api.TypeInputPeer {
    if (!position) return new Api.InputPeerEmpty();
    const entity = this.entities.get(accountId, position.offsetPeerKey);
    // Without accessHash the peer position cannot be restored; resume from the same rate.
    return entity && (entity.kind === 'chat' || entity.accessHash !== null) ? toInputPeer(entity) : new Api.InputPeerEmpty();
  }

  private globalPage(result: unknown, self?: AccountIdentity): GlobalSearchPage {
    const slice = result as SliceLike;
    const messages = normalizeMessages(result, undefined, self);
    const rawCount = Array.isArray(slice.messages) ? slice.messages.length : 0;
    const last = messages[messages.length - 1];
    // Partial pages may have more results; only missing nextRate marks the end.
    const hasMore = rawCount > 0 && last !== undefined && typeof slice.nextRate === 'number';
    return {
      messages,
      next: hasMore ? { offsetRate: slice.nextRate!, offsetPeerKey: last.chatKey, offsetId: last.id } : null,
    };
  }
}
