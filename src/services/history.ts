/**
 * Reads cursor-paginated history, date windows, forum topics, message IDs,
 * surrounding context, and complete albums. History uses GetHistory with
 * offsetId and date bounds; ID lookup uses GetMessages batches of 100.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { AccountIdentity } from '../core/clientPool.js';
import { toInputChannel, toInputPeer } from '../core/entities.js';
import { GatewayError } from '../core/errors.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import { normalizeMessages, totalCount, type MessageDto } from './messages.js';

/** Telegram page limit for history and GetMessages. */
export const PAGE_MAX = 100;

export interface HistoryParams {
  limit: number;
  /** Read messages older than this ID; zero or undefined starts at the newest. */
  offsetId?: number;
  /** Unix timestamps for oldest and newest allowed messages. */
  minDate?: number;
  maxDate?: number;
  topicId?: number;
}

export interface HistoryPage {
  messages: MessageDto[];
  /** Raw teleproto messages in the same order, needed for media downloads. */
  raw: unknown[];
  total: number | null;
  /** Next-page ID, or null when there are no more messages. */
  nextOffsetId: number | null;
}

interface RawMessage {
  id?: number;
}

function rawMessages(result: unknown): RawMessage[] {
  const messages = (result as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as RawMessage[]) : [];
}

export class HistoryService {
  constructor(private readonly tg: Tg) {}

  /** Private outgoing messages omit authors; normalization needs account identity. */
  private async selfIn(accountId: string, chat: EntityRecord): Promise<AccountIdentity | undefined> {
    return chat.kind === 'user' ? this.tg.whoami(accountId) : undefined;
  }

  async page(accountId: string, chat: EntityRecord, params: HistoryParams, options?: TgCallOptions): Promise<HistoryPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const offsetId = params.offsetId ?? 0;
    // offsetDate applies only to the first page; later pages use offsetId.
    const offsetDate = offsetId === 0 && params.maxDate ? params.maxDate : 0;
    const peer = toInputPeer(chat);

    const common = { peer, offsetId, offsetDate, addOffset: 0, limit, maxId: 0, minId: 0, hash: bigInt.zero };
    const result = params.topicId
      ? await this.tg.invoke(accountId, new Api.messages.GetReplies({ ...common, msgId: params.topicId }), options)
      : await this.tg.invoke(accountId, new Api.messages.GetHistory(common), options);

    const fetched = rawMessages(result);
    const dtos = normalizeMessages(result, chat.peerKey, await this.selfIn(accountId, chat));

    let reachedMinDate = false;
    let kept = dtos;
    if (params.minDate) {
      kept = dtos.filter(m => m.date >= params.minDate!);
      reachedMinDate = kept.length < dtos.length;
    }
    const keptIds = new Set(kept.map(m => m.id));
    const last = fetched[fetched.length - 1];

    return {
      messages: kept,
      raw: fetched.filter(m => typeof m.id === 'number' && keptIds.has(m.id)),
      total: totalCount(result),
      nextOffsetId: reachedMinDate || fetched.length < limit || typeof last?.id !== 'number' ? null : last.id,
    };
  }

  /** Looks up at most 100 message IDs and filters messages from other chats. */
  async byIds(accountId: string, chat: EntityRecord, ids: number[], options?: TgCallOptions): Promise<HistoryPage> {
    const unique = [...new Set(ids)].filter(id => Number.isInteger(id) && id > 0);
    if (unique.length === 0) return { messages: [], raw: [], total: 0, nextOffsetId: null };
    if (unique.length > PAGE_MAX) {
      throw new GatewayError('INVALID_ARGUMENT', `At most ${PAGE_MAX} message ids per call.`);
    }
    const inputIds = unique.map(id => new Api.InputMessageID({ id }));
    const result =
      chat.kind === 'channel'
        ? await this.tg.invoke(accountId, new Api.channels.GetMessages({ channel: toInputChannel(chat), id: inputIds }), options)
        : await this.tg.invoke(accountId, new Api.messages.GetMessages({ id: inputIds }), options);

    // messages.GetMessages searches IDs across all account private chats and groups;
    // keep only the requested chat to prevent scope bypass.
    const self = await this.selfIn(accountId, chat);
    const dtos = normalizeMessages(result, chat.kind === 'channel' ? chat.peerKey : undefined, self).filter(m => m.chatKey === chat.peerKey);
    const keptIds = new Set(dtos.map(m => m.id));
    return {
      messages: dtos,
      raw: rawMessages(result).filter(m => typeof m.id === 'number' && keptIds.has(m.id)),
      total: dtos.length,
      nextOffsetId: null,
    };
  }

  /** Message context: `before` older messages and `after` newer messages. */
  async around(
    accountId: string,
    chat: EntityRecord,
    messageId: number,
    before: number,
    after: number,
    topicId?: number,
    options?: TgCallOptions,
  ): Promise<HistoryPage> {
    const b = Math.min(Math.max(0, before), 50);
    const a = Math.min(Math.max(0, after), 50);
    if (a === 0 && b === 0) return this.byIds(accountId, chat, [messageId], options);

    const common = {
      peer: toInputPeer(chat),
      offsetId: messageId,
      // Negative addOffset shifts the window toward newer messages.
      addOffset: -(a + 1),
      offsetDate: 0,
      limit: a + b + 1,
      maxId: 0,
      minId: 0,
      hash: bigInt.zero,
    };
    const result = topicId
      ? await this.tg.invoke(accountId, new Api.messages.GetReplies({ ...common, msgId: topicId }), options)
      : await this.tg.invoke(accountId, new Api.messages.GetHistory(common), options);
    const self = await this.selfIn(accountId, chat);
    return { messages: normalizeMessages(result, chat.peerKey, self), raw: rawMessages(result), total: null, nextOffsetId: null };
  }

  /**
   * Collects an album from one member by neighboring messages with the same groupedId.
   * Albums have at most 10 consecutive messages, so a window of 9 on each side is enough.
   */
  async album(accountId: string, chat: EntityRecord, messageId: number, options?: TgCallOptions): Promise<HistoryPage> {
    const window = await this.around(accountId, chat, messageId, 9, 9, undefined, options);
    const anchor = window.messages.find(m => m.id === messageId);
    if (!anchor) {
      throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${messageId} not found in this chat.`);
    }
    if (anchor.groupedId === null) {
      return { ...window, messages: [anchor], raw: window.raw.filter(m => (m as RawMessage).id === messageId) };
    }
    const messages = window.messages.filter(m => m.groupedId === anchor.groupedId).sort((x, y) => x.id - y.id);
    const ids = new Set(messages.map(m => m.id));
    const raw = window.raw
      .filter(m => typeof (m as RawMessage).id === 'number' && ids.has((m as RawMessage).id!))
      .sort((x, y) => (x as RawMessage).id! - (y as RawMessage).id!);
    return { messages, raw, total: messages.length, nextOffsetId: null };
  }
}
