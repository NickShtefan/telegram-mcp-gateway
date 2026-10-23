import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTg, rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';
import { GatewayError } from '../../core/errors.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { CommentsService } from '../comments.js';
import { HistoryService } from '../history.js';
import { Resolver } from '../resolve.js';
import { SearchService } from '../search.js';
import { TopicsService } from '../topics.js';

const ACC = 'agent';
let storage: SqliteStorage;
let tg: FakeTg;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  storage = new SqliteStorage({ path: ':memory:', now: () => clock });
  storage.accounts.upsert({ id: ACC });
  storage.accounts.upsert({ id: 'other' });
  tg = new FakeTg(storage.entities);
});

afterEach(() => storage.close());

function seedChannel(id: number, extra: Record<string, unknown> = {}) {
  tg.on('contacts.ResolveUsername', (req: { username: string }) => ({
    peer: { className: 'PeerChannel', channelId: BigInt(id) },
    chats: [rawChannel(id, { username: req.username, ...extra })],
    users: [],
  }));
}

describe('Resolver', () => {
  it('resolves usernames once and then uses the account cache', async () => {
    seedChannel(500);
    const resolver = new Resolver({ tg, entities: storage.entities, now: () => clock });
    const first = await resolver.resolve(ACC, 'https://t.me/Fixture_Channel/123?comment=45');
    expect(first.parsed).toMatchObject({ messageId: 123, commentId: 45 });
    expect(first.chat).toMatchObject({ peerKey: '-1000000000500', kind: 'channel', username: 'fixture_channel' });
    await resolver.resolve(ACC, '@fixture_channel');
    expect(tg.callsOf('contacts.ResolveUsername')).toHaveLength(1);
  });

  it('keeps accessHash in a separate cache for each account', async () => {
    seedChannel(500);
    const resolver = new Resolver({ tg, entities: storage.entities, now: () => clock });
    await resolver.resolve(ACC, '@fixture_channel');
    await resolver.resolve('other', '@fixture_channel');
    expect(tg.callsOf('contacts.ResolveUsername').map(c => c.accountId)).toEqual([ACC, 'other']);
  });

  it('revalidates stale cache entries', async () => {
    seedChannel(500);
    const resolver = new Resolver({ tg, entities: storage.entities, now: () => clock });
    await resolver.resolve(ACC, '@fixture_channel');
    clock += 8 * 24 * 60 * 60 * 1000;
    await resolver.resolve(ACC, '@fixture_channel');
    expect(tg.callsOf('contacts.ResolveUsername')).toHaveLength(2);
  });

  it('explains that uncached IDs require a username or link', async () => {
    const resolver = new Resolver({ tg, entities: storage.entities });
    await expect(resolver.resolve(ACC, '-1000000000777')).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND', message: expect.stringContaining('@username') });
    // Basic groups do not need accessHash.
    await expect(resolver.resolve(ACC, '-4321')).resolves.toMatchObject({ chat: { kind: 'chat', peerKey: '-4321' } });
  });

  it('returns channel descriptions, subscribers, and discussion groups', async () => {
    seedChannel(500, { left: true, verified: true });
    tg.on('channels.GetFullChannel', () => ({
      fullChat: { about: 'Market news', participantsCount: 15_000, linkedChatId: 600n },
      chats: [rawChannel(500, { username: 'fixture_channel', left: true, verified: true }), rawChannel(600, { broadcast: false, megagroup: true, title: 'Chat' })],
      users: [],
    }));
    const resolver = new Resolver({ tg, entities: storage.entities });
    const { chat } = await resolver.resolve(ACC, '@fixture_channel');
    const card = await resolver.card(ACC, chat);
    expect(card).toMatchObject({
      type: 'channel',
      about: 'Market news',
      members: 15_000,
      isMember: false,
      verified: true,
      linkedChatKey: '-1000000000600',
      commentsEnabled: true,
      link: 'https://t.me/fixture_channel',
    });
    // The discussion group and its accessHash are also cached.
    expect(storage.entities.get(ACC, '-1000000000600')?.accessHash).not.toBeNull();
  });

  it('distinguishes forums and supergroups by flags', async () => {
    seedChannel(700, { broadcast: false, megagroup: true, forum: true });
    tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900, slowmodeSeconds: 30 }, chats: [rawChannel(700, { username: 'fixture_market', broadcast: false, megagroup: true, forum: true })] }));
    const resolver = new Resolver({ tg, entities: storage.entities });
    const { chat } = await resolver.resolve(ACC, '@fixture_market');
    expect(await resolver.card(ACC, chat)).toMatchObject({ type: 'forum', isMember: true, commentsEnabled: null, slowmodeSeconds: 30 });
  });

  it('allows invite members to read and returns JOIN_REQUIRED to nonmembers', async () => {
    const resolver = new Resolver({ tg, entities: storage.entities });
    tg.on('messages.CheckChatInvite', () => ({ className: 'ChatInviteAlready', chat: rawChannel(800, { broadcast: false, megagroup: true }) }));
    await expect(resolver.resolve(ACC, 't.me/+AbCdEf123')).resolves.toMatchObject({ chat: { peerKey: '-1000000000800' } });

    tg.on('messages.CheckChatInvite', () => ({ className: 'ChatInvite', title: 'Private marketplace', participantsCount: 300, megagroup: true, requestNeeded: true }));
    await expect(resolver.invite(ACC, 'XyZ')).resolves.toMatchObject({ member: false, chat: null, title: 'Private marketplace', members: 300, type: 'supergroup', requestNeeded: true });
    await expect(resolver.resolve(ACC, 't.me/+XyZ')).rejects.toMatchObject({ code: 'JOIN_REQUIRED', message: expect.stringContaining('tg_join') });
  });

  it('forgets stale cache entries after CHAT_NOT_FOUND', async () => {
    seedChannel(500);
    const resolver = new Resolver({ tg, entities: storage.entities });
    const { chat } = await resolver.resolve(ACC, '@fixture_channel');
    tg.on('channels.GetFullChannel', () => {
      throw new GatewayError('CHAT_NOT_FOUND', 'gone');
    });
    await expect(resolver.card(ACC, chat)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    expect(storage.entities.get(ACC, chat.peerKey)).toBeNull();
  });
});

describe('HistoryService', () => {
  const chat = { accountId: ACC, peerKey: '-1000000000500', kind: 'channel' as const, accessHash: '77', username: 'fixture_channel', title: 'Fixture Channel', meta: {}, updatedAt: 0 };
  const page = (ids: number[], extra: Record<string, unknown> = {}) => ({ count: 240, messages: ids.map(id => rawMessage(500, id)), chats: [rawChannel(500)], users: [], ...extra });

  it('returns history pages with next-page cursors', async () => {
    tg.on('messages.GetHistory', () => page([30, 29, 28]));
    const result = await new HistoryService(tg).page(ACC, chat, { limit: 3 });
    expect(result.messages.map(m => m.id)).toEqual([30, 29, 28]);
    expect(result).toMatchObject({ total: 240, nextOffsetId: 28 });
    expect(tg.last('messages.GetHistory').request).toMatchObject({ offsetId: 0, limit: 3, addOffset: 0 });
  });

  it('treats a partial history page as the end', async () => {
    tg.on('messages.GetHistory', () => page([2, 1]));
    expect((await new HistoryService(tg).page(ACC, chat, { limit: 20, offsetId: 3 })).nextOffsetId).toBeNull();
    expect(tg.last('messages.GetHistory').request.offsetId).toBe(3);
  });

  it('uses maxDate to start a date window and minDate to stop it', async () => {
    const base = 1_790_000_000;
    tg.on('messages.GetHistory', () => page([10, 9, 8, 7]));
    const result = await new HistoryService(tg).page(ACC, chat, { limit: 4, maxDate: base + 11 * 60, minDate: base + 9 * 60 });
    expect(tg.last('messages.GetHistory').request.offsetDate).toBe(base + 11 * 60);
    expect(result.messages.map(m => m.id)).toEqual([10, 9]);
    expect(result.raw).toHaveLength(2);
    expect(result.nextOffsetId).toBeNull();
  });

  it('reads forum topics through GetReplies', async () => {
    tg.on('messages.GetReplies', () => page([55, 54]));
    await new HistoryService(tg).page(ACC, chat, { limit: 2, topicId: 5 });
    expect(tg.last('messages.GetReplies').request).toMatchObject({ msgId: 5, limit: 2 });
    expect(tg.callsOf('messages.GetHistory')).toHaveLength(0);
  });

  it('reads channel message IDs through channels.GetMessages with a cap of 100', async () => {
    tg.on('channels.GetMessages', () => page([5, 6]));
    const result = await new HistoryService(tg).byIds(ACC, chat, [5, 6, 6, -1]);
    expect(result.messages.map(m => m.id)).toEqual([5, 6]);
    expect(tg.last('channels.GetMessages').request.id).toHaveLength(2);
    await expect(new HistoryService(tg).byIds(ACC, chat, Array.from({ length: 101 }, (_, i) => i + 1))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('filters other chats from basic-group ID lookups', async () => {
    const group = { ...chat, peerKey: '-4321', kind: 'chat' as const, accessHash: null };
    tg.on('messages.GetMessages', () => ({
      messages: [
        { className: 'Message', id: 5, peerId: { className: 'PeerChat', chatId: 4321n }, date: 1, message: 'ours' },
        { className: 'Message', id: 6, peerId: { className: 'PeerUser', userId: 42n }, date: 1, message: 'another private conversation' },
      ],
      users: [rawUser(42)],
      chats: [],
    }));
    const result = await new HistoryService(tg).byIds(ACC, group, [5, 6]);
    expect(result.messages.map(m => m.text)).toEqual(['ours']);
    expect(result.raw).toHaveLength(1);
  });

  it('attributes outgoing private messages to the account and incoming messages to the contact', async () => {
    const dialog = { ...chat, peerKey: '42', kind: 'user' as const, accessHash: '9', username: 'seller', title: 'Ivan' };
    const peerId = { className: 'PeerUser', userId: 42n };
    const reply = () => ({
      messages: [
        { className: 'Message', id: 6, peerId, out: true, date: 2, message: 'still for sale?' },
        { className: 'Message', id: 5, peerId, date: 1, message: 'hello' },
      ],
      users: [rawUser(42, { username: 'seller' })],
      chats: [],
    });
    tg.on('messages.GetHistory', reply).on('messages.GetMessages', reply);
    const history = new HistoryService(tg);
    const authors = (messages: Array<{ author: { peerKey: string | null; username: string | null } }>) => messages.map(m => [m.author.peerKey, m.author.username]);
    const expected = [['1001', 'agent_acc'], ['42', 'seller']];
    expect(authors((await history.page(ACC, dialog, { limit: 10 })).messages)).toEqual(expected);
    expect(authors((await history.byIds(ACC, dialog, [5, 6])).messages)).toEqual(expected);
    expect(authors((await history.around(ACC, dialog, 5, 1, 1)).messages)).toEqual(expected);
  });

  it('reads context around a message', async () => {
    tg.on('messages.GetHistory', () => page([12, 11, 10, 9, 8]));
    await new HistoryService(tg).around(ACC, chat, 10, 2, 2);
    expect(tg.last('messages.GetHistory').request).toMatchObject({ offsetId: 10, addOffset: -3, limit: 5 });
  });

  it('collects albums by groupedId', async () => {
    tg.on('messages.GetHistory', () => ({
      messages: [
        rawMessage(500, 13),
        rawMessage(500, 12, { groupedId: 9001n }),
        rawMessage(500, 11, { groupedId: 9001n }),
        rawMessage(500, 10, { groupedId: 9001n }),
        rawMessage(500, 9, { groupedId: 8000n }),
      ],
      chats: [rawChannel(500)],
    }));
    const album = await new HistoryService(tg).album(ACC, chat, 11);
    expect(album.messages.map(m => m.id)).toEqual([10, 11, 12]);
    expect(album.raw.map(m => (m as { id: number }).id)).toEqual([10, 11, 12]);
    const single = await new HistoryService(tg).album(ACC, chat, 13);
    expect(single.messages.map(m => m.id)).toEqual([13]);
    await expect(new HistoryService(tg).album(ACC, chat, 99)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });
});

describe('SearchService', () => {
  const chat = { accountId: ACC, peerKey: '-1000000000700', kind: 'channel' as const, accessHash: '5', username: 'fixture_market', title: 'Marketplace', meta: {}, updatedAt: 0 };

  it('returns global search messages with the next-page position', async () => {
    tg.on('messages.SearchGlobal', () => ({
      className: 'messages.MessagesSlice',
      count: 500,
      nextRate: 1234,
      messages: [rawMessage(500, 9), rawMessage(700, 4)],
      chats: [rawChannel(500), rawChannel(700)],
      users: [],
    }));
    const search = new SearchService(tg, storage.entities);
    const first = await search.global(ACC, { query: 'iphone 15', limit: 2, where: 'groups' });
    expect(first.messages.map(m => [m.chatKey, m.id])).toEqual([['-1000000000500', 9], ['-1000000000700', 4]]);
    expect(first.next).toEqual({ offsetRate: 1234, offsetPeerKey: '-1000000000700', offsetId: 4 });
    expect(tg.last('messages.SearchGlobal').request).toMatchObject({ q: 'iphone 15', groupsOnly: true, offsetRate: 0 });
    expect(tg.last('messages.SearchGlobal').request.offsetPeer.className).toBe('InputPeerEmpty');

    await search.global(ACC, { query: 'iphone 15', limit: 2, where: 'groups', position: first.next! });
    const second = tg.last('messages.SearchGlobal').request;
    expect(second).toMatchObject({ offsetRate: 1234, offsetId: 4 });
    expect(second.offsetPeer.className).toBe('InputPeerChannel');
  });

  it('uses missing nextRate rather than page length to detect the end', async () => {
    const search = new SearchService(tg, storage.entities);
    // Telegram may return a partial page even when more results exist.
    tg.on('messages.SearchGlobal', () => ({ className: 'messages.MessagesSlice', messages: [rawMessage(500, 9)], chats: [rawChannel(500)], nextRate: 5 }));
    expect((await search.global(ACC, { query: 'x', limit: 20, where: 'channels' })).next).toEqual({ offsetRate: 5, offsetPeerKey: '-1000000000500', offsetId: 9 });
    tg.on('messages.SearchGlobal', () => ({ className: 'messages.Messages', messages: [rawMessage(500, 9)], chats: [rawChannel(500)] }));
    expect((await search.global(ACC, { query: 'x', limit: 20, where: 'channels' })).next).toBeNull();
    tg.on('messages.SearchGlobal', () => ({ className: 'messages.MessagesSlice', messages: [], chats: [], nextRate: 5 }));
    expect((await search.global(ACC, { query: 'x', limit: 20, where: 'channels' })).next).toBeNull();
  });

  it('searches hashtags without the hash sign', async () => {
    tg.on('channels.SearchPosts', () => ({ messages: [], chats: [] }));
    await new SearchService(tg, storage.entities).hashtag(ACC, '#selling', 20);
    expect(tg.last('channels.SearchPosts').request).toMatchObject({ hashtag: 'selling', limit: 20 });
  });

  it('searches chats by topic, author, and dates', async () => {
    tg.on('messages.Search', () => ({ count: 37, messages: [rawMessage(700, 30), rawMessage(700, 21)], chats: [rawChannel(700)], users: [] }));
    const seller = { accountId: ACC, peerKey: '42', kind: 'user' as const, accessHash: '9', username: 'seller', title: 'S', meta: {}, updatedAt: 0 };
    const result = await new SearchService(tg, storage.entities).inChat(ACC, chat, { query: 'iphone', limit: 2, topicId: 5, from: seller, minDate: 100, maxDate: 200 });
    expect(result).toMatchObject({ total: 37, nextOffsetId: 21 });
    const req = tg.last('messages.Search').request;
    expect(req).toMatchObject({ q: 'iphone', topMsgId: 5, minDate: 100, maxDate: 200, limit: 2 });
    expect(req.fromId.className).toBe('InputPeerUser');
    expect(req.peer.className).toBe('InputPeerChannel');
  });

  it('attributes private-chat search results to the correct authors', async () => {
    const peerId = { className: 'PeerUser', userId: 42n };
    tg.on('messages.Search', () => ({
      messages: [
        { className: 'Message', id: 6, peerId, out: true, date: 2, message: 'price 65k?' },
        { className: 'Message', id: 5, peerId, date: 1, message: 'price 70k' },
      ],
      users: [rawUser(42, { username: 'seller' })],
      chats: [],
    }));
    const dialog = { ...chat, peerKey: '42', kind: 'user' as const, accessHash: '9', username: 'seller', title: 'Ivan' };
    const result = await new SearchService(tg, storage.entities).inChat(ACC, dialog, { query: 'price', limit: 10 });
    expect(result.messages.map(m => m.author.username)).toEqual(['agent_acc', 'seller']);
  });
});

describe('CommentsService', () => {
  const channel = { accountId: ACC, peerKey: '-1000000000500', kind: 'channel' as const, accessHash: '77', username: 'fixture_channel', title: 'Fixture Channel', meta: {}, updatedAt: 0 };
  const comment = (id: number, likes: number) =>
    rawMessage(600, id, { fromId: { className: 'PeerUser', userId: 42n }, reactions: { results: [{ reaction: { emoticon: '👍' }, count: likes }] } });
  const group = rawChannel(600, { broadcast: false, megagroup: true });

  it('reads comment pages from a channel post', async () => {
    tg.on('messages.GetReplies', () => ({ count: 140, messages: [comment(90, 1), comment(89, 5)], chats: [group], users: [rawUser(42, { username: 'reader' })] }));
    const page = await new CommentsService(tg, storage.entities).page(ACC, channel, 10, { limit: 2 });
    expect(page).toMatchObject({ total: 140, nextOffsetId: 89 });
    expect(page.messages[0]).toMatchObject({ chatKey: '-1000000000600', author: { username: 'reader' } });
    expect(tg.last('messages.GetReplies').request).toMatchObject({ msgId: 10, limit: 2 });
  });

  it('top ranks by reactions across multiple pages', async () => {
    const pages = [
      [comment(90, 1), comment(89, 50)],
      [comment(88, 7), comment(87, 99)],
      [comment(86, 3)],
    ];
    let call = 0;
    tg.on('messages.GetReplies', () => ({ count: 5, messages: pages[call++] ?? [], chats: [group], users: [] }));
    const service = new CommentsService(tg, storage.entities);
    // Two messages per page to verify pagination.
    const top = await service.top(ACC, channel, 10, { limit: 2, scan: 2 });
    expect(top.scanned).toBe(2);
    call = 0;
    const full = await service.top(ACC, channel, 10, { limit: 2, scan: 300 });
    expect(full.messages.map(m => m.id)).toEqual([89, 90]);
  });

  it('explains disabled comments and closed discussion groups', async () => {
    const service = new CommentsService(tg, storage.entities);
    tg.on('messages.GetReplies', () => {
      throw new GatewayError('MESSAGE_NOT_FOUND', 'x');
    });
    await expect(service.page(ACC, channel, 10, { limit: 5 })).rejects.toMatchObject({ code: 'COMMENTS_UNAVAILABLE' });
    tg.on('messages.GetReplies', () => {
      throw new GatewayError('CHAT_PRIVATE', 'x');
    });
    await expect(service.page(ACC, channel, 10, { limit: 5 })).rejects.toMatchObject({ code: 'CHAT_PRIVATE', message: expect.stringContaining('discussion group') });
  });

  it('finds thread roots by savedFromMsgId and searches the discussion group', async () => {
    tg.on('messages.GetDiscussionMessage', () => ({
      messages: [
        rawMessage(600, 300, { fwdFrom: { savedFromMsgId: 999 } }),
        rawMessage(600, 301, { fwdFrom: { savedFromMsgId: 10 } }),
      ],
      chats: [group],
      users: [],
    }));
    tg.on('messages.Search', () => ({ count: 1, messages: [comment(310, 0)], chats: [group], users: [] }));
    const service = new CommentsService(tg, storage.entities);
    await expect(service.root(ACC, channel, 10)).resolves.toMatchObject({ rootId: 301, discussion: { peerKey: '-1000000000600' } });
    const found = await service.search(ACC, channel, 10, { query: 'price', limit: 10 });
    expect(found.messages.map(m => m.id)).toEqual([310]);
    expect(tg.last('messages.Search').request).toMatchObject({ q: 'price', topMsgId: 301 });
  });
});

describe('TopicsService', () => {
  const forum = { accountId: ACC, peerKey: '-1000000000700', kind: 'channel' as const, accessHash: '5', username: 'fixture_market', title: 'Marketplace', meta: { forum: true }, updatedAt: 0 };

  it('lists topics without deleted entries', async () => {
    tg.on('messages.GetForumTopics', () => ({
      count: 3,
      topics: [
        { className: 'ForumTopic', id: 1, title: 'General', topMessage: 900, pinned: true, date: 1_700_000_000 },
        { className: 'ForumTopic', id: 5, title: 'Selling', topMessage: 950, closed: false },
        { className: 'ForumTopicDeleted', id: 7 },
      ],
      messages: [],
      chats: [],
      users: [],
    }));
    const all = await new TopicsService(tg).list(ACC, forum, { limit: 50 });
    expect(all.total).toBe(3);
    expect(all.topics).toEqual([
      { id: 1, title: 'General', topMessageId: 900, closed: false, pinned: true, hidden: false, date: 1_700_000_000 },
      { id: 5, title: 'Selling', topMessageId: 950, closed: false, pinned: false, hidden: false, date: null },
    ]);
  });

  it('filters unrelated pinned topics that Telegram returns for every query', async () => {
    tg.on('messages.GetForumTopics', () => ({
      count: 2,
      topics: [
        { className: 'ForumTopic', id: 1, title: 'General', topMessage: 900, pinned: true },
        { className: 'ForumTopic', id: 5, title: 'Selling', topMessage: 950 },
      ],
    }));
    const found = await new TopicsService(tg).list(ACC, forum, { limit: 50, query: 'sell' });
    expect(found.topics.map(t => t.title)).toEqual(['Selling']);
    expect(found.total).toBe(1);
    expect(tg.last('messages.GetForumTopics').request).toMatchObject({ q: 'sell', limit: 50 });

    const none = await new TopicsService(tg).list(ACC, forum, { limit: 50, query: 'zzz' });
    expect(none).toEqual({ topics: [], total: 0 });
  });

  it('explains that channels have no topics without calling Telegram', async () => {
    const channel = { ...forum, meta: { broadcast: true } };
    await expect(new TopicsService(tg).list(ACC, channel, { limit: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('not a forum') });
    expect(tg.callsOf('messages.GetForumTopics')).toHaveLength(0);
  });

  it('explains when a chat is not a forum', async () => {
    tg.on('messages.GetForumTopics', () => {
      throw new GatewayError('TELEGRAM_ERROR', 'Telegram error: CHANNEL_FORUM_MISSING', { telegramCode: 'CHANNEL_FORUM_MISSING' });
    });
    await expect(new TopicsService(tg).list(ACC, forum, { limit: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('not a forum') });
    await expect(new TopicsService(tg).list(ACC, { ...forum, kind: 'chat', peerKey: '-4321' }, { limit: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
