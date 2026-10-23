/**
 * Channel-post comments live in the linked discussion group.
 *
 * `GetDiscussionMessage` finds the thread root (post copy with savedFromMsgId).
 * Read threads in pages of 100 through `GetReplies` for any channel,
 * without writing to the database.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { peerKeyOfPeer, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { totalReactions } from '../core/reactions.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { PAGE_MAX } from './history.js';
import { normalizeMessages, totalCount, type MessageDto } from './messages.js';

export interface CommentsPage {
  messages: MessageDto[];
  total: number | null;
  nextOffsetId: number | null;
}

export interface DiscussionRoot {
  /** Discussion group. */
  discussion: EntityRecord;
  /** ID of the post copy in the group, used as the comment reply target. */
  rootId: number;
}

function commentsUnavailable(err: unknown): never {
  if (isGatewayError(err, 'MESSAGE_NOT_FOUND')) {
    throw new GatewayError('COMMENTS_UNAVAILABLE', 'Comments are disabled for this post, or the post was deleted.', { cause: err });
  }
  if (isGatewayError(err, 'CHAT_PRIVATE')) {
    throw new GatewayError(
      'CHAT_PRIVATE',
      'The discussion group of this channel is private and the account is not a member. The owner has to join it first.',
      { cause: err },
    );
  }
  throw err;
}

export class CommentsService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
  ) {}

  /** Comment page, newest first. */
  async page(
    accountId: string,
    chat: EntityRecord,
    postId: number,
    params: { limit: number; offsetId?: number },
    options?: TgCallOptions,
  ): Promise<CommentsPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    try {
      const result = await this.tg.invoke(
        accountId,
        new Api.messages.GetReplies({
          peer: toInputPeer(chat),
          msgId: postId,
          offsetId: params.offsetId ?? 0,
          offsetDate: 0,
          addOffset: 0,
          limit,
          maxId: 0,
          minId: 0,
          hash: bigInt.zero,
        }),
        options,
      );
      const raw = (result as { messages?: unknown[] }).messages ?? [];
      const messages = normalizeMessages(result);
      const last = raw[raw.length - 1] as { id?: number } | undefined;
      return {
        messages,
        total: totalCount(result),
        nextOffsetId: raw.length < limit || typeof last?.id !== 'number' ? null : last.id,
      };
    } catch (err) {
      return commentsUnavailable(err);
    }
  }

  /**
   * Comments with the most reactions. Telegram cannot sort them this way,
   * so scan the latest `scan` comments and sort locally.
   */
  async top(
    accountId: string,
    chat: EntityRecord,
    postId: number,
    params: { limit: number; scan?: number },
    options?: TgCallOptions,
  ): Promise<CommentsPage & { scanned: number }> {
    const scan = Math.min(Math.max(params.limit, params.scan ?? 300), 500);
    const collected: MessageDto[] = [];
    let offsetId = 0;
    let total: number | null = null;
    while (collected.length < scan) {
      const page = await this.page(accountId, chat, postId, { limit: Math.min(PAGE_MAX, scan - collected.length), offsetId }, options);
      total = page.total ?? total;
      collected.push(...page.messages);
      if (page.nextOffsetId === null) break;
      offsetId = page.nextOffsetId;
    }
    const ranked = [...collected].sort((a, b) => totalReactions(b.reactions) - totalReactions(a.reactions) || b.id - a.id);
    return { messages: ranked.slice(0, params.limit), total, nextOffsetId: null, scanned: collected.length };
  }

  /** Discussion-thread root needed for comment search and replies. */
  async root(accountId: string, chat: EntityRecord, postId: number, options?: TgCallOptions): Promise<DiscussionRoot> {
    let result: unknown;
    try {
      result = await this.tg.invoke(accountId, new Api.messages.GetDiscussionMessage({ peer: toInputPeer(chat), msgId: postId }), options);
    } catch (err) {
      return commentsUnavailable(err);
    }
    const messages = ((result as { messages?: unknown[] }).messages ?? []) as Array<{
      className?: string;
      id?: number;
      peerId?: unknown;
      fwdFrom?: { savedFromMsgId?: number };
    }>;
    const root = messages.find(m => m?.className === 'Message' && m.fwdFrom?.savedFromMsgId === postId) ?? messages.find(m => m?.className === 'Message');
    const key = root ? peerKeyOfPeer(root.peerId) : null;
    const discussion = key ? this.entities.get(accountId, key) : null;
    if (!root || typeof root.id !== 'number' || !discussion) {
      throw new GatewayError('COMMENTS_UNAVAILABLE', 'Could not find the discussion thread of this post.');
    }
    return { discussion, rootId: root.id };
  }

  /** Word search within one post's discussion. */
  async search(
    accountId: string,
    chat: EntityRecord,
    postId: number,
    params: { query: string; limit: number; offsetId?: number },
    options?: TgCallOptions,
  ): Promise<CommentsPage> {
    const { discussion, rootId } = await this.root(accountId, chat, postId, options);
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.messages.Search({
        peer: toInputPeer(discussion),
        q: params.query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetId: params.offsetId ?? 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
        topMsgId: rootId,
      }),
      options,
    );
    const raw = (result as { messages?: unknown[] }).messages ?? [];
    const last = raw[raw.length - 1] as { id?: number } | undefined;
    return {
      messages: normalizeMessages(result, discussion.peerKey),
      total: totalCount(result),
      nextOffsetId: raw.length < limit || typeof last?.id !== 'number' ? null : last.id,
    };
  }
}
