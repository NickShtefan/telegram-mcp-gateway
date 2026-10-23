/**
 * `analytics` toolset: channel statistics from public counters. The gateway
 * calculates numbers; the agent interprets them (decision 7).
 */
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { messageLink } from '../../services/links.js';
import { STATS_MAX_DAYS, STATS_MAX_POSTS } from '../../services/stats.js';
import { clampLimit } from '../args.js';
import { compactNumber, formatDate } from '../format.js';
import { defineTool, type ToolDef } from '../tool.js';
import { accountArg, chatArg, chatHeader } from './shared.js';

const signed = (value: number, suffix = ''): string => `${value > 0 ? '+' : ''}${value}${suffix}`;

const tgChannelStats = defineTool({
  name: 'tg_channel_stats',
  toolset: 'analytics',
  title: 'Channel statistics',
  description:
    'Numbers about a channel over a period, counted from its public counters: subscribers and their change, posts per week, average and median views, reach (views to subscribers), engagement (reactions to views), comments and shares per post, share of reposts, views trend, weekly breakdown, top posts. Subscriber change appears once the gateway has seen the channel on an earlier day.',
  input: {
    chat: chatArg,
    days: z.number().int().optional().describe(`Period in days: default 30, max ${STATS_MAX_DAYS}.`),
    max_posts: z.number().int().optional().describe(`Stop after this many posts: default 300, max ${STATS_MAX_POSTS}. Every 100 posts is one request.`),
    account: accountArg,
  },
  readOnly: true,
  handler: async (args, ctx) => {
    const accountId = ctx.account(args.account);
    const { chat } = await ctx.openChat(args.chat, accountId);
    if (chat.kind === 'user') throw new GatewayError('INVALID_ARGUMENT', 'Statistics exist for channels and groups, not for people.');
    const days = clampLimit(args.days, 30, STATS_MAX_DAYS);
    const report = await ctx.services.stats.channel(accountId, chat, { days, maxPosts: clampLimit(args.max_posts, 300, STATS_MAX_POSTS) });
    const s = report.stats;
    const fresh = ctx.services.runtime.storage.entities.get(accountId, chat.peerKey) ?? chat;
    const isChannel = fresh.meta.broadcast === true;
    const unit = isChannel ? 'posts' : 'messages';

    const lines = [`Statistics of ${chatHeader(fresh)} for the last ${days} days: ${s.posts} ${unit}`];
    if (report.truncated) {
      lines.push(`Only the newest ${s.posts} ${unit} were read (max_posts): the period is covered back to ${s.oldestDate !== null ? formatDate(s.oldestDate) : 'unknown'} UTC.`);
    }

    const members = report.members;
    if (members !== null) {
      let line = `${isChannel ? 'subscribers' : 'members'}: ${compactNumber(members)} (${members})`;
      if (report.earlier) {
        const diff = members - report.earlier.members;
        const pct = report.earlier.members > 0 ? Math.round((diff / report.earlier.members) * 1000) / 10 : 0;
        line += ` | on ${report.earlier.day}: ${report.earlier.members} (${signed(diff)}, ${signed(pct, '%')})`;
      } else {
        line += ' | change: no earlier snapshot yet, the gateway remembers the count from today';
      }
      lines.push(line);
    }

    if (s.posts === 0) {
      lines.push(`No ${unit} in this period.`);
      return { accountId, peerKey: chat.peerKey, count: 0, text: lines.join('\n') };
    }

    lines.push(
      [`${unit}: ${s.posts} (${s.postsPerWeek} per week)`, isChannel ? `reposts from elsewhere: ${s.forwardedShare}%` : `authors: ${s.authors}`].join(' | '),
    );
    if (s.avgViews !== null) {
      lines.push(
        [`views per post: avg ${compactNumber(s.avgViews)}`, `median ${compactNumber(s.medianViews ?? 0)}`, s.viewsSpread !== null ? `spread ${s.viewsSpread}%` : ''].filter(Boolean).join(' | '),
      );
      if (s.reachRate !== null) lines.push(`reach: an average post is seen by ${s.reachRate}% of subscribers`);
      if (s.err !== null) lines.push(`engagement (ERR): ${s.err}% of views leave a reaction`);
    }
    lines.push(
      [
        `per post: ${s.reactionsPerPost} reactions`,
        s.commentsPerPost !== null ? `${s.commentsPerPost} comments` : '',
        s.sharesPerPost !== null ? `${s.sharesPerPost} shares` : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
    if (s.topReactions.length > 0) {
      const shown = s.topReactions.map(r => `${r.reaction.startsWith('custom:') ? 'custom' : r.reaction} ${r.share}%`).join(', ');
      lines.push(`reactions used: ${shown} (${s.reactionKinds} kinds)`);
    }
    if (s.viewsTrend !== null) lines.push(`trend: views per post ${signed(s.viewsTrend, '%')} in the newer half of the period against the older half`);
    if (s.avgViews !== null && s.settledPosts < s.posts) lines.push(`View numbers use ${s.settledPosts} posts older than 24 hours: newer ones are still gaining views.`);

    if (s.weeks.length > 1) {
      lines.push('', 'By week (Monday, UTC):');
      for (const w of s.weeks.slice(0, 12)) {
        lines.push(`${w.weekStart} | ${w.posts} ${w.posts === 1 ? unit.slice(0, -1) : unit}${w.avgViews !== null ? ` | avg views ${compactNumber(w.avgViews)}` : ''}`);
      }
    }
    if (s.topPosts.length > 0) {
      lines.push('', 'Top posts by views:');
      for (const p of s.topPosts) {
        const link = messageLink({ username: fresh.username, peerKey: fresh.peerKey, messageId: p.id });
        lines.push(`#${p.id} | ${formatDate(p.date)} | views ${compactNumber(p.views ?? 0)}${p.replies ? ` | comments ${p.replies}` : ''}${link ? ` | ${link}` : ''}`);
      }
    }
    return { accountId, peerKey: chat.peerKey, count: s.posts, text: lines.join('\n') };
  },
});

export const ANALYTICS_TOOLS: ToolDef[] = [tgChannelStats] as unknown as ToolDef[];
