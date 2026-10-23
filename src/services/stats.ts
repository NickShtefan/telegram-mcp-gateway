/**
 * Channel statistics: reach, engagement, posting frequency, and trends.
 *
 * Formulas include mean and median
 * views, reach (views/subscribers), ERR (reactions/views),
 * view dispersion, and comparison of the recent and older period halves.
 * No scores or verdicts are assigned: the gateway returns numbers,
 * and the agent interprets them (decision 7).
 *
 * Telegram exposes subscriber growth only to channel administrators.
 * For other channels, retain participant counts when observed and show
 * changes between snapshots.
 */
import type { ReactionCount } from '../core/reactions.js';
import type { TgCallOptions } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import { PAGE_MAX, type HistoryService } from './history.js';
import type { MessageDto } from './messages.js';
import type { Resolver } from './resolve.js';

export const STATS_MAX_DAYS = 180;
export const STATS_MAX_POSTS = 1000;
/** Exclude recent posts from averages when at least three settled posts exist. */
const SETTLE_SECONDS = 24 * 3600;
const DAY = 86_400;

export interface MemberSnapshot {
  day: string;
  ts: number;
  members: number;
}

/** Daily public participant snapshots, stored per chat rather than per account. */
export class SnapshotStore {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(chatKey: string, members: number | null): void {
    if (members === null || !Number.isFinite(members) || members < 0) return;
    const ts = this.now();
    this.storage.db
      .prepare(
        `INSERT INTO chat_snapshots (chat_key, day, ts, members) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_key, day) DO UPDATE SET ts = excluded.ts, members = excluded.members`,
      )
      .run(chatKey, new Date(ts).toISOString().slice(0, 10), ts, Math.trunc(members));
  }

  /** Chat snapshots, oldest first. */
  list(chatKey: string): MemberSnapshot[] {
    return (this.storage.db.prepare('SELECT day, ts, members FROM chat_snapshots WHERE chat_key = ? ORDER BY day').all(chatKey) as Array<Record<string, unknown>>).map(r => ({
      day: String(r.day),
      ts: Number(r.ts),
      members: Number(r.members),
    }));
  }
}

export interface WeekBucket {
  /** Monday of the week, YYYY-MM-DD in UTC. */
  weekStart: string;
  posts: number;
  avgViews: number | null;
}

export interface ChannelStats {
  posts: number;
  /** Post count used for view calculations, excluding the newest posts. */
  settledPosts: number;
  postsPerWeek: number;
  /** Unix timestamp of the oldest post used in calculations. */
  oldestDate: number | null;
  avgViews: number | null;
  medianViews: number | null;
  /** View standard deviation divided by mean, percent. */
  viewsSpread: number | null;
  /** Mean views divided by subscribers, percent. */
  reachRate: number | null;
  /** Reactions divided by views, percent. */
  err: number | null;
  reactionsPerPost: number;
  commentsPerPost: number | null;
  sharesPerPost: number | null;
  topReactions: Array<{ reaction: string; share: number }>;
  reactionKinds: number;
  forwardedShare: number;
  /** Mean view change between the recent and older period halves, percent. */
  viewsTrend: number | null;
  weeks: WeekBucket[];
  topPosts: MessageDto[];
  /** For groups: number of distinct posting authors. */
  authors: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const avg = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Counts albums as one post, retaining a captioned message and maximum counters. */
export function collapseAlbums(messages: MessageDto[]): MessageDto[] {
  const out: MessageDto[] = [];
  const albums = new Map<string, MessageDto>();
  for (const m of messages) {
    if (m.service !== null) continue;
    if (m.groupedId === null) {
      out.push(m);
      continue;
    }
    const seen = albums.get(m.groupedId);
    if (!seen) {
      const copy = { ...m };
      albums.set(m.groupedId, copy);
      out.push(copy);
      continue;
    }
    if (!seen.text && m.text) seen.text = m.text;
    seen.views = Math.max(seen.views ?? 0, m.views ?? 0) || seen.views;
    if (m.reactions.length > seen.reactions.length) seen.reactions = m.reactions;
    seen.replies = Math.max(seen.replies ?? 0, m.replies ?? 0) || seen.replies;
    seen.forwards = Math.max(seen.forwards ?? 0, m.forwards ?? 0) || seen.forwards;
  }
  return out;
}

function mondayOf(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const shift = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - shift)).toISOString().slice(0, 10);
}

/** Calculates window metrics from unordered messages, handling service messages and albums. */
export function computeStats(messages: MessageDto[], members: number | null, nowSec: number, windowStartSec: number): ChannelStats {
  const posts = collapseAlbums(messages).sort((a, b) => b.date - a.date);
  const withViews = posts.filter(p => p.views !== null);
  // Recent posts are still gaining views; use all posts if too few mature posts remain.
  const settledOnly = withViews.filter(p => p.date <= nowSec - SETTLE_SECONDS);
  const settled = settledOnly.length >= 3 ? settledOnly : withViews;
  const views = settled.map(p => p.views!);

  const oldestDate = posts.length > 0 ? posts[posts.length - 1]!.date : null;
  const spanWeeks = Math.max(1, (nowSec - Math.max(windowStartSec, oldestDate ?? windowStartSec)) / (7 * DAY));

  const reactionTotals = new Map<string, number>();
  let reactions = 0;
  for (const p of posts) {
    for (const r of p.reactions as ReactionCount[]) {
      reactions += r.count;
      reactionTotals.set(r.reaction, (reactionTotals.get(r.reaction) ?? 0) + r.count);
    }
  }
  const settledReactions = settled.reduce((s, p) => s + p.reactions.reduce((x, r) => x + r.count, 0), 0);
  const totalViews = views.reduce((s, v) => s + v, 0);
  const avgViews = views.length > 0 ? avg(views) : null;

  let viewsSpread: number | null = null;
  if (avgViews !== null && avgViews > 0 && views.length > 1) {
    const variance = views.reduce((s, v) => s + (v - avgViews) ** 2, 0) / views.length;
    viewsSpread = round1((Math.sqrt(variance) / avgViews) * 100);
  }

  // Split the period at its midpoint into recent and older posts.
  const middle = (nowSec + windowStartSec) / 2;
  const newer = settled.filter(p => p.date >= middle).map(p => p.views!);
  const older = settled.filter(p => p.date < middle).map(p => p.views!);
  const viewsTrend = newer.length >= 3 && older.length >= 3 && avg(older) > 0 ? round1(((avg(newer) - avg(older)) / avg(older)) * 100) : null;

  const weekMap = new Map<string, { posts: number; views: number[] }>();
  for (const p of posts) {
    const key = mondayOf(p.date);
    const bucket = weekMap.get(key) ?? { posts: 0, views: [] };
    bucket.posts++;
    if (p.views !== null) bucket.views.push(p.views);
    weekMap.set(key, bucket);
  }
  const weeks = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([weekStart, b]) => ({ weekStart, posts: b.posts, avgViews: b.views.length > 0 ? Math.round(avg(b.views)) : null }));

  const comments = posts.filter(p => p.replies !== null).map(p => p.replies!);
  const shares = posts.filter(p => p.forwards !== null).map(p => p.forwards!);
  const authors = new Set(posts.map(p => p.author.peerKey).filter(Boolean)).size;

  return {
    posts: posts.length,
    settledPosts: settled.length,
    postsPerWeek: round1(posts.length / spanWeeks),
    oldestDate,
    avgViews: avgViews !== null ? Math.round(avgViews) : null,
    medianViews: views.length > 0 ? Math.round(median(views)) : null,
    viewsSpread,
    reachRate: avgViews !== null && members !== null && members > 0 ? round1((avgViews / members) * 100) : null,
    err: totalViews > 0 ? Math.round((settledReactions / totalViews) * 10_000) / 100 : null,
    reactionsPerPost: posts.length > 0 ? round1(reactions / posts.length) : 0,
    commentsPerPost: comments.length > 0 ? round1(avg(comments)) : null,
    sharesPerPost: shares.length > 0 ? round1(avg(shares)) : null,
    topReactions: [...reactionTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reaction, count]) => ({ reaction, share: Math.round((count / reactions) * 100) })),
    reactionKinds: reactionTotals.size,
    forwardedShare: posts.length > 0 ? Math.round((posts.filter(p => p.forwardedFrom !== null).length / posts.length) * 100) : 0,
    viewsTrend,
    weeks,
    topPosts: [...withViews].sort((a, b) => b.views! - a.views!).slice(0, 3),
    authors,
  };
}

export interface StatsReport {
  stats: ChannelStats;
  members: number | null;
  /** Earliest participant snapshot within the period, excluding today's snapshot. */
  earlier: MemberSnapshot | null;
  /** Post cap truncated history before the full period was covered. */
  truncated: boolean;
}

export interface StatsServiceDeps {
  history: HistoryService;
  resolver: Resolver;
  snapshots: SnapshotStore;
  now?: () => number;
}

export class StatsService {
  private readonly now: () => number;

  constructor(private readonly deps: StatsServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async channel(accountId: string, chat: EntityRecord, params: { days: number; maxPosts: number }, options?: TgCallOptions): Promise<StatsReport> {
    const nowSec = Math.floor(this.now() / 1000);
    const days = Math.min(Math.max(1, params.days), STATS_MAX_DAYS);
    const maxPosts = Math.min(Math.max(1, params.maxPosts), STATS_MAX_POSTS);
    const windowStartSec = nowSec - days * DAY;

    const card = await this.deps.resolver.card(accountId, chat, options);
    this.deps.snapshots.record(chat.peerKey, card.members);

    const messages: MessageDto[] = [];
    let offsetId = 0;
    let truncated = false;
    for (;;) {
      const page = await this.deps.history.page(accountId, chat, { limit: PAGE_MAX, offsetId, minDate: windowStartSec }, options);
      messages.push(...page.messages);
      if (page.nextOffsetId === null) break;
      if (messages.length >= maxPosts) {
        truncated = true;
        break;
      }
      offsetId = page.nextOffsetId;
    }

    const today = new Date(this.now()).toISOString().slice(0, 10);
    const windowDay = new Date(windowStartSec * 1000).toISOString().slice(0, 10);
    const earlier = this.deps.snapshots.list(chat.peerKey).find(s => s.day >= windowDay && s.day < today) ?? null;

    return { stats: computeStats(messages, card.members, nowSec, windowStartSec), members: card.members, earlier, truncated };
  }
}
