/**
 * Forum topics. Marketplaces often separate 'Selling', 'Buying', and
 * 'Exchange'. Topic lists let search, history, and exports
 * distinguish offers from wanted listings.
 */
import { Api } from 'teleproto';
import { toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';

export interface TopicDto {
  id: number;
  title: string;
  /** Latest message ID in the topic. */
  topMessageId: number | null;
  closed: boolean;
  pinned: boolean;
  hidden: boolean;
  /** Topic creation time in Unix seconds. */
  date: number | null;
}

export interface TopicsPage {
  topics: TopicDto[];
  total: number | null;
}

interface RawTopic {
  className?: string;
  id?: number;
  title?: string;
  topMessage?: number;
  closed?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  date?: number;
}

export class TopicsService {
  constructor(private readonly tg: Tg) {}

  async list(accountId: string, chat: EntityRecord, params: { query?: string; limit: number }, options?: TgCallOptions): Promise<TopicsPage> {
    if (chat.kind !== 'channel') {
      throw new GatewayError('INVALID_ARGUMENT', 'Forum topics exist only in supergroups with topics enabled.');
    }
    // Channels have no topics; avoid Telegram's misleading chat-not-found response.
    if (chat.meta.broadcast === true) {
      throw new GatewayError('INVALID_ARGUMENT', 'This chat is a channel, not a forum: it has no topics. Read it with tg_read_history without topic.');
    }
    let result: { count?: number; topics?: RawTopic[] };
    try {
      result = (await this.tg.invoke(
        accountId,
        // Since 2025, topics are not limited to supergroups; the method moved to messages.
        new Api.messages.GetForumTopics({
          peer: toInputPeer(chat),
          q: params.query || undefined,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: Math.min(Math.max(1, params.limit), 100),
        }),
        options,
      )) as unknown as { count?: number; topics?: RawTopic[] };
    } catch (err) {
      if (isGatewayError(err, 'TELEGRAM_ERROR') && /FORUM/.test(err.telegramCode ?? '')) {
        throw new GatewayError('INVALID_ARGUMENT', 'This chat is not a forum: it has no topics. Read it with tg_read_history without topic.', {
          cause: err,
        });
      }
      throw err;
    }

    // Telegram returns pinned topics even without matches; keep only matching titles.
    const wanted = (params.query ?? '').trim().toLowerCase();
    const topics = (result.topics ?? [])
      .filter(t => t && t.className === 'ForumTopic' && typeof t.id === 'number')
      .filter(t => wanted === '' || (t.title ?? '').toLowerCase().includes(wanted))
      .map(t => ({
        id: t.id!,
        title: t.title ?? '',
        topMessageId: typeof t.topMessage === 'number' ? t.topMessage : null,
        closed: t.closed === true,
        pinned: t.pinned === true,
        hidden: t.hidden === true,
        date: typeof t.date === 'number' ? t.date : null,
      }));
    // Telegram counts unrelated pinned topics too; use the filtered count.
    return { topics, total: wanted !== '' ? topics.length : typeof result.count === 'number' ? result.count : null };
  }
}
