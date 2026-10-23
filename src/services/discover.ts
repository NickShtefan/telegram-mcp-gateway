/**
 * Channel discovery by title, Telegram recommendations, and repost
 * sources.
 *
 * Explore recommendations by depth and count repost sources from `fwdFrom`.
 * Each call uses the limiter; returned chats enter the account cache,
 * allowing other tools to open discovered channels immediately.
 */
import { Api } from 'teleproto';
import { entityFromApi, peerKeyOfPeer, toInputChannel, type EntityInfo } from '../core/entities.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { PAGE_MAX, type HistoryService } from './history.js';
import { chatTypeOf, type ChatType } from './resolve.js';

export interface FoundChat {
  chat: EntityInfo;
  type: ChatType;
  members: number | null;
  /** Whether the account already belongs to this chat. */
  member: boolean;
  verified: boolean;
  scam: boolean;
}

export interface SimilarResult {
  chats: FoundChat[];
  /** Total known similar channels; non-Premium accounts see only a subset. */
  total: number | null;
}

export interface ForwardSource {
  peerKey: string;
  chat: EntityRecord | null;
  count: number;
  /** Unix timestamp of the most recent repost from this source. */
  lastDate: number;
}

export interface ForwardSourcesResult {
  scanned: number;
  forwards: number;
  /** Reposts from people and hidden sources. */
  hidden: number;
  sources: ForwardSource[];
  /** Timestamp of the oldest scanned message. */
  oldestDate: number | null;
}

export const FIND_MAX = 30;
export const FORWARD_SCAN_MAX = 500;
/** Explore second-level recommendations only for the largest first-level channels. */
const SIMILAR_TOP_PER_LEVEL = 3;
const SIMILAR_MAX = 60;

function toFound(info: EntityInfo, memberHint?: boolean): FoundChat {
  return {
    chat: info,
    type: chatTypeOf(info),
    members: typeof info.meta.participants === 'number' ? info.meta.participants : null,
    member: memberHint ?? info.meta.member === true,
    verified: info.meta.verified === true,
    scam: info.meta.scam === true,
  };
}

function chatInfos(result: unknown): Map<string, EntityInfo> {
  const out = new Map<string, EntityInfo>();
  const chats = (result as { chats?: unknown[] } | null)?.chats;
  for (const item of Array.isArray(chats) ? chats : []) {
    const info = entityFromApi(item);
    if (info && info.kind !== 'user') out.set(info.peerKey, info);
  }
  return out;
}

export class DiscoverService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
    private readonly history: HistoryService,
  ) {}

  /**
   * Public channels and groups matching title or username words. Telegram
   * searches names rather than post contents.
   */
  async find(accountId: string, query: string, limit: number, options?: TgCallOptions): Promise<FoundChat[]> {
    const result = (await this.tg.invoke(
      accountId,
      new Api.contacts.Search({ q: query, limit: Math.min(Math.max(1, limit), FIND_MAX) }),
      options,
    )) as unknown as { myResults?: unknown[]; results?: unknown[] };
    const infos = chatInfos(result);
    const found: FoundChat[] = [];
    const seen = new Set<string>();
    for (const [peers, mine] of [
      [result.myResults ?? [], true],
      [result.results ?? [], false],
    ] as const) {
      for (const peer of peers) {
        const key = peerKeyOfPeer(peer);
        const info = key !== null ? infos.get(key) : undefined;
        if (!info || seen.has(info.peerKey)) continue;
        seen.add(info.peerKey);
        found.push(toFound(info, mine ? true : undefined));
      }
    }
    return found.slice(0, limit);
  }

  /** Telegram recommendations; depth 2 expands from the largest discovered channels. */
  async similar(accountId: string, channel: EntityRecord, depth: 1 | 2, options?: TgCallOptions): Promise<SimilarResult> {
    const fetch = async (target: { peerKey: string; accessHash: string | null }): Promise<{ infos: EntityInfo[]; total: number | null }> => {
      const result = await this.tg.invoke(accountId, new Api.channels.GetChannelRecommendations({ channel: toInputChannel(target) }), options);
      const count = (result as { count?: number }).count;
      return { infos: [...chatInfos(result).values()], total: typeof count === 'number' ? count : null };
    };

    const first = await fetch(channel);
    const seen = new Set<string>([channel.peerKey]);
    const chats: FoundChat[] = [];
    const add = (infos: EntityInfo[]): void => {
      for (const info of infos) {
        if (seen.has(info.peerKey) || chats.length >= SIMILAR_MAX) continue;
        seen.add(info.peerKey);
        chats.push(toFound(info));
      }
    };
    add(first.infos);

    if (depth === 2) {
      const seeds = [...chats]
        .filter(c => c.chat.accessHash !== null)
        .sort((a, b) => (b.members ?? 0) - (a.members ?? 0))
        .slice(0, SIMILAR_TOP_PER_LEVEL);
      for (const seed of seeds) {
        try {
          add((await fetch(seed.chat)).infos);
        } catch {
          // Missing recommendations for one channel must not abort exploration.
        }
      }
    }
    return { chats, total: first.total };
  }

  /** Counts repost sources in the channel's latest posts. */
  async forwardSources(
    accountId: string,
    chat: EntityRecord,
    params: { posts: number; minDate?: number },
    options?: TgCallOptions,
  ): Promise<ForwardSourcesResult> {
    const wanted = Math.min(Math.max(1, params.posts), FORWARD_SCAN_MAX);
    const counts = new Map<string, { count: number; lastDate: number }>();
    let scanned = 0;
    let forwards = 0;
    let hidden = 0;
    let oldestDate: number | null = null;
    let offsetId = 0;

    while (scanned < wanted) {
      const page = await this.history.page(accountId, chat, { limit: Math.min(PAGE_MAX, wanted - scanned), offsetId, minDate: params.minDate }, options);
      for (const m of page.messages) {
        if (m.service !== null) continue;
        scanned++;
        oldestDate = oldestDate === null ? m.date : Math.min(oldestDate, m.date);
        if (!m.forwardedFrom) continue;
        forwards++;
        const source = m.forwardedFrom.peerKey;
        // Keep channel/group sources, excluding people and the source chat itself.
        if (source === null || !source.startsWith('-') || source === chat.peerKey) {
          hidden++;
          continue;
        }
        const entry = counts.get(source) ?? { count: 0, lastDate: 0 };
        entry.count++;
        entry.lastDate = Math.max(entry.lastDate, m.date);
        counts.set(source, entry);
      }
      if (page.nextOffsetId === null) break;
      offsetId = page.nextOffsetId;
    }

    const sources = [...counts.entries()]
      .map(([peerKey, v]) => ({ peerKey, chat: this.entities.get(accountId, peerKey), count: v.count, lastDate: v.lastDate }))
      .sort((a, b) => b.count - a.count || b.lastDate - a.lastDate);
    return { scanned, forwards, hidden, sources, oldestDate };
  }
}
