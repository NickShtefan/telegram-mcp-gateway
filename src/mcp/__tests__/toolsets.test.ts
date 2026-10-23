import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeAccount } from '../../cli/admin.js';
import { createLogger } from '../../core/log.js';
import { writePrivateMode } from '../../policy/scopes.js';
import { HistoryService } from '../../services/history.js';
import { JobManager } from '../../services/jobs.js';
import { buildMatch, IndexStore, LocalIndexService } from '../../services/localIndex.js';
import { collapseAlbums, computeStats } from '../../services/stats.js';
import { normalizeMessages } from '../../services/messages.js';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';

let gw: TestGateway;
let user_a: TestClient;
let clock: number;

const DAY = 86_400;
const NOW_SEC = Math.floor(Date.UTC(2026, 9, 1, 12, 0, 0) / 1000);

beforeEach(async () => {
  clock = NOW_SEC * 1000;
  gw = makeTestGateway({ now: () => clock });
  user_a = await gw.client('user_a');
});

afterEach(async () => {
  await user_a.close();
  gw.cleanup();
});

/** A channel or supergroup dialog and its latest message. */
function channelDialog(id: number, topMessage: number, date: number, extra: Record<string, unknown> = {}) {
  return {
    dialog: { className: 'Dialog', peer: { className: 'PeerChannel', channelId: BigInt(id) }, topMessage, unreadCount: 0, ...extra },
    message: { className: 'Message', id: topMessage, date, peerId: { className: 'PeerChannel', channelId: BigInt(id) } },
  };
}

interface DialogsRequest {
  folderId?: number;
  offsetDate: number;
  offsetId: number;
  offsetPeer: { className: string; channelId?: unknown };
  limit: number;
}

describe('tg_list_dialogs: account chats', () => {
  const pinned = channelDialog(500, 90, NOW_SEC - 40 * DAY, { pinned: true });
  const flea = channelDialog(700, 5000, NOW_SEC - 3600, { unreadCount: 12 });
  const news = channelDialog(800, 77, NOW_SEC - 2 * DAY);
  const archived = channelDialog(900, 15, NOW_SEC - 90 * DAY);
  const friend = {
    dialog: { className: 'Dialog', peer: { className: 'PeerUser', userId: 42n }, topMessage: 9, unreadCount: 1 },
    message: { className: 'Message', id: 9, date: NOW_SEC - 60, peerId: { className: 'PeerUser', userId: 42n } },
  };
  const chats = [
    rawChannel(500, { username: 'fixture_channel', title: 'Fixture Channel', participantsCount: 289 }),
    rawChannel(700, { username: 'fixture_market_cy', title: 'Cyprus Marketplace', broadcast: false, megagroup: true, forum: true, participantsCount: 12_400 }),
    rawChannel(800, { title: 'News without a link' }),
    rawChannel(900, { username: 'old_channel', title: 'Old channel' }),
  ];

  beforeEach(() => {
    gw.tg.on('messages.GetDialogs', (req: DialogsRequest) => {
      if (req.folderId === 1) {
        return { className: 'messages.Dialogs', dialogs: [archived.dialog], messages: [archived.message], chats, users: [] };
      }
      const main = [pinned, friend, flea, news];
      return {
        className: 'messages.Dialogs',
        dialogs: [{ className: 'DialogFolder', folder: { id: 1 } }, ...main.map(d => d.dialog)],
        messages: main.map(d => d.message),
        chats,
        users: [rawUser(42, { username: 'friend', firstName: 'Friend' })],
      };
    });
  });

  it('lists channels and groups including archived chats while excluding private conversations', async () => {
    const reply = await user_a.call('tg_list_dialogs');
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Chats of account agent: 4 shown (scanned 5)');
    expect(reply.text).toContain('@fixture_channel "Fixture Channel" | channel | 289 members | last message 2026-08-22 | pinned | id -1000000000500');
    expect(reply.text).toContain('@fixture_market_cy "Cyprus Marketplace" | forum | 12.4k members | unread 12 | last message 2026-10-01 | id -1000000000700');
    expect(reply.text).toContain('"News without a link" (id -1000000000800) | channel | last message 2026-09-29');
    expect(reply.text).toContain('@old_channel "Old channel" | channel | last message 2026-07-03 | archived | id -1000000000900');
    expect(reply.text).not.toContain('friend');
    expect(reply.text).not.toContain('Friend');
    expect(reply.text).not.toContain('next_cursor');

    // Main list, then archive; the first page has no offset.
    const calls = gw.tg.callsOf('messages.GetDialogs').map(c => c.request as DialogsRequest);
    expect(calls.map(c => c.folderId)).toEqual([0, 1]);
    expect(calls[0]!.offsetPeer.className).toBe('InputPeerEmpty');
    expect(calls[0]!.limit).toBe(100);
    // Requests use real teleproto classes and can be serialized.
    for (const call of gw.tg.callsOf('messages.GetDialogs')) expect(() => call.request.getBytes()).not.toThrow();
  });

  it('type=private lists only conversations opened for reading by the owner', async () => {
    const closed = await user_a.call('tg_list_dialogs', { type: 'private' });
    expect(closed.text).toContain('0 shown, private only');
    expect(closed.text).not.toContain('friend');

    // Send mode does not grant read access.
    writePrivateMode(gw.storage, 'user_a', 'agent', 'send');
    expect((await user_a.call('tg_list_dialogs', { type: 'private' })).text).not.toContain('friend');

    writePrivateMode(gw.storage, 'user_a', 'agent', 'open');
    const open = await user_a.call('tg_list_dialogs', { type: 'private' });
    expect(open.text).toContain('1 shown, private only');
    expect(open.text).toContain('@friend "Friend" | user | unread 1');
    expect(open.text).not.toContain('@fixture_channel');
    // The default list still excludes people.
    expect((await user_a.call('tg_list_dialogs')).text).not.toContain('friend');

    // A conversation opened by an explicit rule is also visible.
    writePrivateMode(gw.storage, 'user_a', 'agent', 'closed');
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: 'friend', effect: 'allow' });
    expect((await user_a.call('tg_list_dialogs', { type: 'private' })).text).toContain('@friend');
  });

  it('filters by title and type and resolves listed chats by ID', async () => {
    const byName = await user_a.call('tg_list_dialogs', { query: 'market' });
    expect(byName.text).toContain('1 shown, matching "market"');
    expect(byName.text).toContain('@fixture_market_cy');
    expect(byName.text).not.toContain('@fixture_channel');

    const groups = await user_a.call('tg_list_dialogs', { type: 'groups' });
    expect(groups.text).toContain('1 shown, groups only');
    const channels = await user_a.call('tg_list_dialogs', { type: 'channels' });
    expect(channels.text).toContain('3 shown, channels only');
    expect(channels.text).not.toContain('fixture_market_cy');

    expect((await user_a.call('tg_list_dialogs', { query: 'no such chat' })).text).toContain('Nothing matched.');

    // Chats without usernames are now known and can be read by their listed IDs.
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    const history = await user_a.call('tg_read_history', { chat: '-1000000000800' });
    expect(history.isError, history.text).toBe(false);
  });

  it('hides owner-blocked chats and denies dialog lists to rule-based launches', async () => {
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: '-1000000000700', effect: 'deny' });
    const reply = await user_a.call('tg_list_dialogs');
    expect(reply.text).not.toContain('fixture_market_cy');
    expect(reply.text).toContain('3 shown');
  });

  it('paginates long lists from the last shown chat', async () => {
    const many = Array.from({ length: 150 }, (_, i) => channelDialog(2000 + i, 10 + i, NOW_SEC - i * 600));
    const manyChats = many.map((_, i) => rawChannel(2000 + i, { username: `chan${i}`, title: `Channel ${i}` }));
    gw.tg.on('messages.GetDialogs', (req: DialogsRequest) => {
      if (req.folderId === 1) return { className: 'messages.Dialogs', dialogs: [], messages: [], chats: [], users: [] };
      const start = req.offsetId === 0 ? 0 : many.findIndex(d => d.dialog.topMessage === req.offsetId) + 1;
      const slice = many.slice(start, start + req.limit);
      return { className: 'messages.DialogsSlice', count: 150, dialogs: slice.map(d => d.dialog), messages: slice.map(d => d.message), chats: manyChats, users: [] };
    });

    const first = await user_a.call('tg_list_dialogs', { limit: 60 });
    expect(first.text).toContain('60 shown');
    expect(first.text).toContain('@chan59');
    expect(first.text).not.toContain('@chan60 ');
    const cursor = first.text.match(/next_cursor: (\S+)/)![1]!;

    const second = await user_a.call('tg_list_dialogs', { limit: 100, cursor });
    expect(second.text).toContain('90 shown');
    expect(second.text).toContain('@chan60 ');
    expect(second.text).toContain('@chan149');
    expect(second.text).not.toContain('next_cursor');
    // Resume from the 60th chat using its date, message ID, and peer.
    const resumed = gw.tg.callsOf('messages.GetDialogs').map(c => c.request as DialogsRequest).find(r => r.offsetId === 69)!;
    expect(resumed.offsetDate).toBe(NOW_SEC - 59 * 600);
    expect(resumed.offsetPeer.className).toBe('InputPeerChannel');
    expect(String(resumed.offsetPeer.channelId)).toBe('2059');
  });
});

describe('discover toolset: channel discovery', () => {
  const DISCOVER = ['core', 'discover'];
  let agent: TestClient;
  const peer = (id: number) => ({ className: 'PeerChannel', channelId: BigInt(id) });
  const mine = rawChannel(500, { username: 'fixture_channel', title: 'Fixture Channel', participantsCount: 289 });
  const big = rawChannel(3001, { username: 'crypto_news', title: 'Crypto news', participantsCount: 54_000, verified: true, left: true });
  const group = rawChannel(3002, { username: 'crypto_chat', title: 'Crypto chat', broadcast: false, megagroup: true, participantsCount: 9_100, scam: true, left: true });

  beforeEach(async () => {
    agent = await gw.client('user_a', DISCOVER);
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) => {
      if (req.username.toLowerCase() === 'crypto_chat') return { peer: peer(3002), chats: [group], users: [] };
      return { peer: peer(500), chats: [mine], users: [] };
    });
  });

  afterEach(async () => {
    await agent.close();
  });

  it('exposes discover tools only when the toolset is enabled', async () => {
    const names = (await agent.tools()).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['tg_find_channels', 'tg_similar_channels', 'tg_forward_sources']));
    expect((await user_a.tools()).map(t => t.name)).not.toContain('tg_find_channels');
    for (const tool of (await agent.tools()).filter(t => /find_channels|similar|forward_sources/.test(t.name))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/anyOf|oneOf|allOf/);
    }
  });

  it('tg_find_channels searches channel and group titles without returning people', async () => {
    gw.tg.on('contacts.Search', () => ({
      className: 'contacts.Found',
      myResults: [peer(500)],
      results: [peer(3001), { className: 'PeerUser', userId: 77n }, peer(3002)],
      chats: [mine, big, group],
      users: [rawUser(77, { username: 'crypto_guy', firstName: 'Crypto' })],
    }));
    const reply = await agent.call('tg_find_channels', { query: 'crypto' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Channels and groups matching "crypto": 3');
    expect(reply.text).toContain('@fixture_channel "Fixture Channel" | channel | 289 members | the account is a member');
    expect(reply.text).toContain('@crypto_news "Crypto news" | channel | 54k members | verified');
    expect(reply.text).toContain('@crypto_chat "Crypto chat" | supergroup | 9.1k members | SCAM or FAKE');
    expect(reply.text).not.toContain('crypto_guy');
    const call = gw.tg.last('contacts.Search');
    expect(call.request).toMatchObject({ q: 'crypto', limit: 20 });
    expect(() => call.request.getBytes()).not.toThrow();

    // Discovered channels are already known and need no extra username resolution.
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    const before = gw.tg.callsOf('contacts.ResolveUsername').length;
    expect((await agent.call('tg_read_history', { chat: '@crypto_news' })).isError).toBe(false);
    expect(gw.tg.callsOf('contacts.ResolveUsername')).toHaveLength(before);

    // Hide channels blocked by the owner.
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: 'crypto_news', effect: 'deny' });
    expect((await agent.call('tg_find_channels', { query: 'crypto' })).text).not.toContain('crypto_news');
    expect((await agent.call('tg_find_channels', { query: 'x' })).isError).toBe(true);
  });

  it('tg_similar_channels explores a second recommendation level from the three largest channels', async () => {
    const rec = (id: number, members: number) => rawChannel(id, { username: `rec${id}`, title: `Rec ${id}`, participantsCount: members, left: true });
    gw.tg.on('channels.GetChannelRecommendations', (req: { channel: { channelId: unknown } }) => {
      const id = Number(req.channel.channelId);
      if (id === 500) return { className: 'messages.ChatsSlice', count: 40, chats: [rec(3001, 54_000), rec(3002, 10_000), rec(3003, 200_000), rec(3004, 1_000)] };
      if (id === 3003) return { className: 'messages.Chats', chats: [rec(3010, 5_000), rec(3001, 54_000)] };
      if (id === 3001) throw new Error('CHANNEL_PRIVATE');
      return { className: 'messages.Chats', chats: [rec(3011, 700)] };
    });

    const one = await agent.call('tg_similar_channels', { chat: '@fixture_channel' });
    expect(one.isError, one.text).toBe(false);
    expect(one.text).toContain('Channels similar to @fixture_channel: 4');
    // Largest channels first.
    expect(one.text.indexOf('@rec3003')).toBeLessThan(one.text.indexOf('@rec3001'));
    expect(one.text).toContain('@rec3003 "Rec 3003" | channel | 200k members');
    expect(one.text).toContain('Telegram knows 40 similar channels but shows the full list only to Premium accounts.');
    expect(gw.tg.callsOf('channels.GetChannelRecommendations')).toHaveLength(1);
    expect(() => gw.tg.last('channels.GetChannelRecommendations').request.getBytes()).not.toThrow();

    const two = await agent.call('tg_similar_channels', { chat: '@fixture_channel', depth: 2 });
    expect(two.text).toContain('6 (two levels)');
    expect(two.text).toContain('@rec3010');
    expect(two.text).toContain('@rec3011');
    // Exclude the source and duplicates; one failed neighbor does not abort exploration.
    expect(two.text.match(/@rec3001 /g)).toHaveLength(1);
    expect(gw.tg.callsOf('channels.GetChannelRecommendations')).toHaveLength(1 + 4);

    const notChannel = await agent.call('tg_similar_channels', { chat: '@crypto_chat' });
    expect(notChannel.isError).toBe(true);
    expect(notChannel.text).toContain('only for broadcast channels');
  });

  it('tg_forward_sources counts channel repost sources', async () => {
    const posts = [
      rawMessage(500, 20, { fwdFrom: { fromId: peer(3001), channelPost: 7 } }),
      rawMessage(500, 19),
      rawMessage(500, 18, { fwdFrom: { fromId: peer(3001), channelPost: 6 } }),
      rawMessage(500, 17, { fwdFrom: { fromId: peer(3002), channelPost: 3 } }),
      rawMessage(500, 16, { fwdFrom: { fromName: 'Hidden author' } }),
      rawMessage(500, 15, { fwdFrom: { fromId: { className: 'PeerUser', userId: 77n } } }),
      { className: 'MessageService', id: 14, peerId: peer(500), date: 1_790_000_000, action: { className: 'MessageActionPinMessage' } },
      rawMessage(500, 13, { fwdFrom: { fromId: peer(3999), channelPost: 1 } }),
    ];
    gw.tg.on('messages.GetHistory', () => ({ messages: posts, chats: [mine, big, group], users: [rawUser(77, { firstName: 'Someone' })] }));

    const reply = await agent.call('tg_forward_sources', { chat: '@fixture_channel' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Forward sources of @fixture_channel: 6 forwards in 7 posts (86%)');
    const lines = reply.text.split('\n');
    expect(lines.find(l => l.startsWith('2x'))).toContain('@crypto_news "Crypto news" | 54k members | last ');
    expect(lines.find(l => l.includes('@crypto_chat'))).toMatch(/^1x \| @crypto_chat/);
    expect(reply.text).toContain('1x | id -1000000003999 (not resolvable: private or deleted)');
    expect(reply.text).toContain('2 more forward(s) came from people or from sources that hide themselves.');
    expect(reply.text).not.toContain('Hidden author');
  });

  it('tg_forward_sources paginates history up to the requested post count', async () => {
    const all = Array.from({ length: 260 }, (_, i) => rawMessage(500, 1000 - i, i % 10 === 0 ? { fwdFrom: { fromId: peer(3001), channelPost: i } } : {}));
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : all.findIndex(m => m.id === req.offsetId) + 1;
      return { messages: all.slice(start, start + req.limit), chats: [mine, big], users: [] };
    });
    const reply = await agent.call('tg_forward_sources', { chat: '@fixture_channel', posts: 150 });
    expect(reply.text).toContain('15 forwards in 150 posts (10%)');
    expect(gw.tg.callsOf('messages.GetHistory').map(c => (c.request as { limit: number }).limit)).toEqual([100, 50]);
    expect((await agent.call('tg_forward_sources', { chat: '@fixture_channel', posts: 5000 })).text).toContain('in 260 posts');
  });
});

describe('analytics toolset: channel statistics', () => {
  let agent: TestClient;
  let members: number;
  const chan = () => rawChannel(500, { username: 'fixture_channel', title: 'Fixture Channel' });
  const reaction = (emoticon: string, count: number) => ({ reaction: { className: 'ReactionEmoji', emoticon }, count });
  const at = (daysAgo: number) => NOW_SEC - Math.round(daysAgo * DAY);
  const post = (id: number, daysAgo: number, views: number, extra: Record<string, unknown> = {}) =>
    rawMessage(500, id, { post: true, date: at(daysAgo), views, message: `Post ${id}`, ...extra });

  const feed = () => [
    post(70, 0.2, 50, { reactions: { results: [reaction('👍', 1)] } }),
    post(60, 2, 400, { reactions: { results: [reaction('👍', 8), reaction('❤', 2)] }, replies: { replies: 4, comments: true }, forwards: 2 }),
    post(50, 5, 300, { reactions: { results: [reaction('👍', 6)] }, replies: { replies: 2, comments: true }, forwards: 1 }),
    post(40, 9, 200, { reactions: { results: [reaction('🔥', 4)] }, replies: { replies: 0, comments: true }, forwards: 0, fwdFrom: { fromId: { className: 'PeerChannel', channelId: 3001n }, channelPost: 5 } }),
    post(30, 20, 100, { message: 'Advertisement. Buy the course erid: 2Vtzq', replies: { replies: 0, comments: true }, forwards: 1 }),
    { className: 'MessageService', id: 25, peerId: { className: 'PeerChannel', channelId: 500n }, date: at(22), action: { className: 'MessageActionPinMessage' } },
    post(21, 25, 190, { message: '', groupedId: 9n }),
    post(20, 25, 200, { message: 'Album caption', groupedId: 9n }),
    post(10, 28, 150),
  ];

  beforeEach(async () => {
    members = 1000;
    agent = await gw.client('user_a', ['core', 'analytics']);
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: 500n }, chats: [chan()], users: [] }));
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: members, about: 'about' }, chats: [chan()], users: [] }));
    gw.tg.on('messages.GetHistory', () => ({ messages: feed(), chats: [chan()], users: [] }));
  });

  afterEach(async () => {
    await agent.close();
  });

  it('calculates reach, engagement, dispersion, and trend, counting an album as one post', () => {
    const stats = computeStats(normalizeMessages({ messages: feed(), chats: [chan()], users: [] }, '-1000000000500'), 1000, NOW_SEC, NOW_SEC - 30 * DAY);
    expect(stats).toMatchObject({
      posts: 7,
      settledPosts: 6,
      postsPerWeek: 1.8,
      avgViews: 225,
      medianViews: 200,
      viewsSpread: 44,
      reachRate: 22.5,
      err: 1.48,
      reactionsPerPost: 3,
      commentsPerPost: 1.5,
      sharesPerPost: 1,
      reactionKinds: 3,
      forwardedShare: 14,
      viewsTrend: 100,
    });
    expect(stats.topReactions).toEqual([{ reaction: '👍', share: 71 }, { reaction: '🔥', share: 19 }, { reaction: '❤', share: 10 }]);
    expect(stats.topPosts.map(p => p.id)).toEqual([60, 50, 40]);
    // An album uses one captioned message and its maximum view count.
    const album = collapseAlbums(normalizeMessages({ messages: feed(), chats: [chan()], users: [] }, '-1000000000500')).filter(m => m.groupedId !== null);
    expect(album).toHaveLength(1);
    expect(album[0]).toMatchObject({ text: 'Album caption', views: 200 });
  });

  it('uses all posts when none have matured and omits reach without subscriber counts', () => {
    const few = normalizeMessages({ messages: [post(2, 0.1, 30), post(1, 0.5, 60)], chats: [chan()], users: [] }, '-1000000000500');
    const stats = computeStats(few, null, NOW_SEC, NOW_SEC - 7 * DAY);
    expect(stats).toMatchObject({ posts: 2, settledPosts: 2, avgViews: 45, reachRate: null, viewsTrend: null, err: 0 });
    expect(computeStats([], 100, NOW_SEC, NOW_SEC - 7 * DAY)).toMatchObject({ posts: 0, avgViews: null, medianViews: null, err: null, postsPerWeek: 0 });
  });

  it('tg_channel_stats reports channel metrics and subscriber changes between days', async () => {
    const first = await agent.call('tg_channel_stats', { chat: '@fixture_channel' });
    expect(first.isError, first.text).toBe(false);
    expect(first.text).toContain('Statistics of @fixture_channel [channel] for the last 30 days: 7 posts');
    expect(first.text).toContain('subscribers: 1k (1000) | change: no earlier snapshot yet');
    expect(first.text).toContain('posts: 7 (1.8 per week) | reposts from elsewhere: 14%');
    expect(first.text).not.toContain('ads');
    expect(first.text).toContain('views per post: avg 225 | median 200 | spread 44%');
    expect(first.text).toContain('reach: an average post is seen by 22.5% of subscribers');
    expect(first.text).toContain('engagement (ERR): 1.48% of views leave a reaction');
    expect(first.text).toContain('per post: 3 reactions, 1.5 comments, 1 shares');
    expect(first.text).toContain('reactions used: 👍 71%, 🔥 19%, ❤ 10% (3 kinds)');
    expect(first.text).toContain('trend: views per post +100% in the newer half of the period against the older half');
    expect(first.text).toContain('View numbers use 6 posts older than 24 hours');
    expect(first.text).toContain('#60 | 2026-09-29 12:00 | views 400 | comments 4 | https://t.me/fixture_channel/60');
    expect(first.text).toMatch(/By week \(Monday, UTC\):\n2026-09-28 \| 2 posts \| avg views 225/);
    // Statistics do not contain post texts.
    expect(first.text).not.toContain('Buy the course');

    // Three days later, subscriber growth is visible against the first snapshot.
    clock += 3 * DAY * 1000;
    members = 1100;
    const later = await agent.call('tg_channel_stats', { chat: '@fixture_channel', days: 14 });
    expect(later.text).toContain('subscribers: 1.1k (1100) | on 2026-10-01: 1000 (+100, +10%)');
  });

  it('tg_channel_stats handles post caps, empty periods, and people passed as channels', async () => {
    const all = Array.from({ length: 250 }, (_, i) => post(1000 - i, i * 0.1 + 2, 100));
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : all.findIndex(m => m.id === req.offsetId) + 1;
      return { messages: all.slice(start, start + req.limit), chats: [chan()], users: [] };
    });
    const capped = await agent.call('tg_channel_stats', { chat: '@fixture_channel', max_posts: 100 });
    expect(capped.text).toContain('Only the newest 100 posts were read (max_posts)');
    expect(gw.tg.callsOf('messages.GetHistory')).toHaveLength(1);

    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [chan()], users: [] }));
    expect((await agent.call('tg_channel_stats', { chat: '@fixture_channel' })).text).toContain('No posts in this period.');

    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'seller' })] }));
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: 'seller', effect: 'allow' });
    expect((await agent.call('tg_channel_stats', { chat: '@seller' })).text).toContain('not for people');
    expect((await user_a.tools()).map(t => t.name)).not.toContain('tg_channel_stats');
  });
});

describe('index toolset: local indexing and search', () => {
  const INDEX = ['core', 'index'];
  const FLEA = 700;
  let agent: TestClient;
  /** Chat history, newest first. */
  let feed: Array<Record<string, unknown>>;
  const flea = () => rawChannel(FLEA, { username: 'fixture_market', title: 'Marketplace', broadcast: false, megagroup: true });
  const at = (daysAgo: number) => NOW_SEC - Math.round(daysAgo * DAY);
  const msg = (id: number, daysAgo: number, text: string, extra: Record<string, unknown> = {}) =>
    rawMessage(FLEA, id, { date: at(daysAgo), message: text, fromId: { className: 'PeerUser', userId: 42n }, ...extra });
  const historyCalls = () => gw.tg.callsOf('messages.GetHistory').length;

  beforeEach(async () => {
    agent = await gw.client('user_a', INDEX);
    feed = [
      msg(110, 1, 'Selling bicycles Stels, two available, 12,000 RUB each'),
      msg(109, 2, 'Buying iPhone 15 Pro, used'),
      msg(108, 5, 'BICYCLE for children, free to collect near the café'),
      { className: 'MessageService', id: 107, peerId: { className: 'PeerChannel', channelId: BigInt(FLEA) }, date: at(6), action: { className: 'MessageActionChatAddUser' } },
      msg(106, 10, 'Apartment for rent in Limassol, 1200 EUR'),
      msg(105, 20, 'Selling scooter and helmet'),
      msg(104, 45, 'Old listing: bicycle pump'),
      msg(103, 80, 'Very old listing: selling skis'),
    ];
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) => {
      if (req.username.toLowerCase() === 'fixture_channel') return { peer: { className: 'PeerChannel', channelId: 500n }, chats: [rawChannel(500, { username: 'fixture_channel', title: 'Fixture Channel' })], users: [] };
      return { peer: { className: 'PeerChannel', channelId: BigInt(FLEA) }, chats: [flea()], users: [] };
    });
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : feed.findIndex(m => (m.id as number) < req.offsetId);
      const slice = start === -1 ? [] : feed.slice(start, start + req.limit);
      return { messages: slice, chats: [flea()], users: [rawUser(42, { username: 'seller', firstName: 'John' })] };
    });
  });

  afterEach(async () => {
    await agent.close();
  });

  it('matches word forms, case, and all query words without Telegram calls', async () => {
    const indexed = await agent.call('tg_index', { chat: '@fixture_market', since: '30d' });
    expect(indexed.isError, indexed.text).toBe(false);
    // Five messages in 30 days; service messages are not indexed.
    expect(indexed.text).toContain('Indexed @fixture_market: 5 messages in the local index (5 new,');
    expect(indexed.text).toContain('The index covers this chat since 2026-09-01 12:00 UTC');
    expect(gw.tg.last('messages.GetHistory').options).toMatchObject({ priority: 'background' });

    const before = gw.tg.calls.length;
    const bikes = await agent.call('tg_local_search', { query: 'bicycle' });
    expect(bikes.text).toContain('Local search "bicycle": 2 of 2 matches in 1 indexed chat(s)');
    expect(bikes.text).toContain('#110');
    expect(bikes.text).toContain('#108');
    expect(bikes.text).toContain('https://t.me/fixture_market/110');
    expect(bikes.text).toMatch(/> Selling bicycles Stels/);
    expect(bikes.text).toContain('Index last synced: 2026-10-01 12:00 UTC');
    // Messages outside the selected period were not indexed.
    expect(bikes.text).not.toContain('pump');

    expect((await agent.call('tg_local_search', { query: 'SELLING scooter' })).text).toContain('1 of 1 matches');
    expect((await agent.call('tg_local_search', { query: 'selling apartment' })).text).toContain('0 of 0 matches');
    expect((await agent.call('tg_local_search', { query: 'selling', since: '3d' })).text).toContain('1 of 1 matches');
    expect((await agent.call('tg_local_search', { query: 'bicycle', mode: 'full' })).text).toContain('<<<TG:');
    // Unicode text remains searchable after the English-only fixture translation.
    expect((await agent.call('tg_local_search', { query: 'CAFÉ' })).text).toContain('#108');
    // None of the searches called Telegram.
    expect(gw.tg.calls.length).toBe(before);
  });

  it('handles short query words and punctuation safely', async () => {
    await agent.call('tg_index', { chat: '@fixture_market' });
    const short = await agent.call('tg_local_search', { query: 'iphone us' });
    expect(short.isError, short.text).toBe(false);
    expect(short.text).toContain('#109');
    expect(short.text).toContain('1 of 1 matches');
    expect((await agent.call('tg_local_search', { query: 'iphone 15' })).text).toContain('#109');
    expect((await agent.call('tg_local_search', { query: 'us' })).text).toContain('at least one query word of 3 or more characters');
    // FTS operators remain literal text.
    const odd = await agent.call('tg_local_search', { query: '"bicycle" OR NEAR( * selling' });
    expect(odd.isError, odd.text).toBe(false);
    expect(buildMatch('a"b  bicycle')).toEqual({ match: '"a""b" "bicycle"', short: [] });
  });

  it.each(['alternating', 'sparse'])('paginates %s short-word matches without repeats or missing rows', async pattern => {
    feed = Array.from({ length: 40 }, (_, i) => {
      const id = 140 - i;
      const matches = pattern === 'alternating' ? i % 2 === 0 : i === 31 || i === 37;
      return msg(id, 1 + i / 100, `bicycle ${matches ? 'ÉX' : 'listing'}`);
    });
    await agent.call('tg_index', { chat: '@fixture_market', since: '30d' });
    const expected = feed.filter(m => String(m.message).includes('ÉX')).map(m => m.id);
    const received: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const reply = await agent.call('tg_local_search', { query: 'bicycle éx', limit: 3, cursor });
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.text).toContain(`of ${expected.length} matches`);
      received.push(...Array.from(reply.text.matchAll(/#(\d+)/g), m => Number(m[1])));
      cursor = reply.text.match(/next_cursor: (\S+)/)?.[1];
      if (!cursor) break;
    }
    expect(received).toEqual(expected);
    expect(new Set(received).size).toBe(received.length);
    expect(cursor).toBeUndefined();
    // No short words: FTS pagination still covers every row.
    const all = await agent.call('tg_local_search', { query: 'bicycle', limit: 100 });
    expect(all.text).toContain('40 of 40 matches');
  });

  it('refreshes new and edited messages with few Telegram calls on repeated runs', async () => {
    await agent.call('tg_index', { chat: '@fixture_market', since: '30d' });
    const callsAfterFirst = historyCalls();

    // A new listing arrives and yesterday's author edits an existing listing.
    feed.unshift(msg(111, 0.1, 'Selling Yamaha guitar'));
    feed[1] = msg(110, 1, 'SOLD. Bicycles are gone');
    clock += 3600 * 1000;
    const again = await agent.call('tg_index', { chat: '@fixture_market', since: '30d' });
    expect(again.text).toContain('6 messages in the local index (1 new,');
    expect(historyCalls() - callsAfterFirst).toBe(1);

    expect((await agent.call('tg_local_search', { query: 'guitar' })).text).toContain('#111');
    expect((await agent.call('tg_local_search', { query: 'Stels' })).text).toContain('0 of 0 matches');
    expect((await agent.call('tg_local_search', { query: 'sold' })).text).toContain('#110');
  });

  it('extends the period backward by reading only the remaining tail', async () => {
    await agent.call('tg_index', { chat: '@fixture_market', since: '30d' });
    expect((await agent.call('tg_local_search', { query: 'pump' })).text).toContain('0 of 0 matches');
    const wider = await agent.call('tg_index', { chat: '@fixture_market', since: '60d' });
    expect(wider.text).toContain('6 messages in the local index (1 new,');
    expect(wider.text).toContain('covers this chat since 2026-08-02');
    expect((await agent.call('tg_local_search', { query: 'pump' })).text).toContain('#104');
    expect((await agent.call('tg_local_search', { query: 'skis' })).text).toContain('0 of 0 matches');

    const list = await agent.call('tg_index', { action: 'list' });
    expect(list.text).toContain('Indexed chats: 1');
    expect(list.text).toContain('@fixture_market | account agent | 6 messages | since 2026-08-02 | synced 2026-10-01 12:00');
    // Periods can also use years, up to three years.
    expect((await agent.call('tg_index', { chat: '@fixture_market', since: '1y' })).text).toContain('covers this chat since 2025-10-01');
    expect((await agent.call('tg_index', { chat: '@fixture_market', since: '9y' })).text).toContain('covers this chat since 2023-10-02');
    expect((await agent.call('tg_index', { chat: '@fixture_market', since: 'long ago' })).text).toContain('Use a relative period (30d, 12h, 2w, 6mo, 1y)');
  });

  it('paginates results and searches a single chat', async () => {
    feed = Array.from({ length: 25 }, (_, i) => msg(300 - i, 1 + i * 0.1, `Selling chair number ${i}`));
    await agent.call('tg_index', { chat: '@fixture_market' });
    const first = await agent.call('tg_local_search', { query: 'chair', limit: 10 });
    expect(first.text).toContain('10 of 25 matches');
    const cursor = first.text.match(/next_cursor: (\S+)/)![1]!;
    const second = await agent.call('tg_local_search', { query: 'chair', limit: 10, cursor });
    expect(second.text).toContain('#290');
    expect(second.text).not.toContain('#291 ');
    expect((await agent.call('tg_local_search', { query: 'table', cursor })).text).toContain('cursor belongs to another query');

    expect((await agent.call('tg_local_search', { query: 'chair', chat: '@fixture_market', limit: 50 })).text).toContain('25 of 25 matches');
    const notIndexed = await agent.call('tg_local_search', { query: 'chair', chat: '@fixture_channel' });
    expect(notIndexed.isError).toBe(true);
    expect(notIndexed.text).toContain('@fixture_channel is not indexed');
  });

  it('shares account indexes, hides blocked chats, and allows only creators to delete indexes', async () => {
    await agent.call('tg_index', { chat: '@fixture_market' });
    const user_b = await gw.client('user_b', INDEX);
    // Another user searches the same index on shared account agent.
    expect((await user_b.call('tg_local_search', { query: 'bicycle', account: 'agent' })).text).toContain('3 of 3 matches');
    const denied = await user_b.call('tg_index', { action: 'remove', chat: '@fixture_market', account: 'agent' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('was created by user_a');

    // Blocking the chat hides its index from this user's search and list.
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: '-1000000000700', effect: 'deny' });
    expect((await agent.call('tg_local_search', { query: 'bicycle' })).text).toContain('Nothing is indexed yet');
    expect((await agent.call('tg_index', { action: 'list' })).text).toContain('Indexed chats: 0');
    expect((await user_b.call('tg_local_search', { query: 'bicycle', account: 'agent' })).text).toContain('3 of 3 matches');
    await user_b.close();
    expect((await user_a.tools()).map(t => t.name)).not.toContain('tg_local_search');
  });

  it('removes stored message text when deleting an index or account', async () => {
    await agent.call('tg_index', { chat: '@fixture_market' });
    const count = (table: string) => Number((gw.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    // The default 90-day period contains seven non-service messages.
    expect(count('indexed_messages')).toBe(7);
    expect(count('indexed_fts')).toBe(7);

    const removed = await agent.call('tg_index', { action: 'remove', chat: '@fixture_market' });
    expect(removed.text).toContain('7 messages deleted from the gateway');
    expect(count('indexed_messages')).toBe(0);
    expect(count('indexed_fts')).toBe(0);
    expect((await agent.call('tg_index', { action: 'remove', chat: '@fixture_market' })).text).toContain('is not indexed');

    await agent.call('tg_index', { chat: '@fixture_market' });
    expect(count('indexed_fts')).toBe(7);
    removeAccount(gw.storage, 'agent');
    expect(count('indexed_messages')).toBe(0);
    expect(count('indexed_fts')).toBe(0);
    expect(count('indexed_chats')).toBe(0);
  });

  it('returns job_id for long indexing and prevents a second job on the same chat', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const page = { messages: [msg(1, 1, 'Selling table')], chats: [flea()], users: [] };
    gw.tg.on('messages.GetHistory', async () => {
      await gate;
      return page;
    });
    await agent.call('tg_resolve', { ref: '@fixture_market' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = agent.call('tg_index', { chat: '@fixture_market' });
      await vi.advanceTimersByTimeAsync(21_000);
      const started = await pending;
      expect(started.text).toContain('Indexing of @fixture_market is running');
      const jobId = started.text.match(/job_id: (job_[0-9a-f]+)/)![1]!;

      const second = agent.call('tg_index', { chat: '@fixture_market' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await second).text).toContain(jobId);
      expect(gw.storage.jobs.list({ limit: 10 }).filter(j => j.kind === 'index')).toHaveLength(1);

      release();
      await vi.advanceTimersByTimeAsync(10);
      expect((await agent.call('tg_index', { job_id: jobId })).text).toContain('Indexed @fixture_market: 1 messages');
    } finally {
      vi.useRealTimers();
    }
  });

  it('indexes large chats across capped runs without coverage gaps', async () => {
    feed = Array.from({ length: 450 }, (_, i) => msg(1000 - i, 1 + i * 0.05, `Listing number ${1000 - i}`));
    await agent.call('tg_resolve', { ref: '@fixture_market' });
    const store = new IndexStore(gw.storage, () => clock);
    const service = new LocalIndexService({ storage: gw.storage, store, history: new HistoryService(gw.tg), now: () => clock, maxPerRun: 200 });
    const jobs = new JobManager({ storage: gw.storage, log: createLogger('test', { level: 'silent' }) });
    jobs.register('index', ctx => service.run(ctx));
    const run = async () => {
      const job = jobs.start({ userId: 'user_a', accountId: 'agent', kind: 'index', params: { accountId: 'agent', chatKey: '-1000000000700', sinceTs: at(60) } });
      return (await jobs.waitFor(job.id, 'user_a', 5_000)).result as { partial: boolean; messages: number; sinceTs: number };
    };

    const first = await run();
    expect(first).toMatchObject({ partial: true, messages: 200 });
    // Coverage extends only to the oldest message actually read.
    expect(first.sinceTs).toBe(at(1 + 199 * 0.05));
    // Later runs refresh the head first, then continue deeper into history.
    const second = await run();
    expect(second).toMatchObject({ partial: true, messages: 300 });
    let last = second;
    let runs = 2;
    while (last.partial && runs < 8) {
      last = await run();
      runs++;
    }
    expect(runs).toBe(4);
    expect(last).toMatchObject({ partial: false, messages: 450, sinceTs: at(60) });
    expect(store.get('agent', '-1000000000700')).toMatchObject({ newestId: 1000, oldestId: 551, messages: 450 });
    jobs.stop();
  });
});

describe('all toolset contracts', () => {
  it('gives each tool a flat schema, short description, and correct read hint', async () => {
    const everything = await gw.client('user_a', ['core', 'discover', 'analytics', 'index', 'write']);
    const tools = await everything.tools();
    await everything.close();
    expect(tools.map(t => t.name).sort()).toEqual([
      'tg_channel_stats',
      'tg_confirm',
      'tg_export',
      'tg_find_channels',
      'tg_forward_sources',
      'tg_get_comments',
      'tg_get_media',
      'tg_get_message',
      'tg_index',
      'tg_join',
      'tg_list_dialogs',
      'tg_list_topics',
      'tg_local_search',
      'tg_press_button',
      'tg_react',
      'tg_read_history',
      'tg_reply',
      'tg_resolve',
      'tg_search_chat',
      'tg_search_messages',
      'tg_send',
      'tg_similar_channels',
      'tg_status',
    ]);
    const writes = new Set(['tg_confirm', 'tg_join', 'tg_press_button', 'tg_react', 'tg_reply', 'tg_send']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writes.has(tool.name));
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/anyOf|oneOf|allOf/);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
      for (const [name, prop] of Object.entries(props)) {
        expect(['string', 'number', 'integer', 'boolean', 'array'], `${tool.name}.${name}`).toContain(prop.type);
        if (prop.type === 'array') expect(['string', 'number', 'integer'], `${tool.name}.${name}`).toContain(prop.items?.type);
      }
      expect((tool.description ?? '').length, tool.name).toBeLessThan(520);
    }
    // The gateway only provides tools; it never launches agents, watches chats, or manages assignments.
    expect(tools.map(t => t.name).filter(n => /watch|inbox|rule|task|runner/.test(n))).toEqual([]);
    expect(tools).toHaveLength(23);
  });
});
