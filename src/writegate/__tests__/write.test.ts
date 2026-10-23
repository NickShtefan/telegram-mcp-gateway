import { RPCMessageToError } from 'teleproto/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';
import { APPROVAL_TTL_MS } from '../approvals.js';
import { classifyError, GatewayError } from '../../core/errors.js';
import { writePrivateMode } from '../../policy/scopes.js';
import { sentMessageId } from '../../services/write.js';

const CHANNEL = 500;
const GROUP = 600;
const ALL = ['core', 'write'];

let gw: TestGateway;
let user_a: TestClient;
let clock: number;

const channel = (extra: Record<string, unknown> = {}) => rawChannel(CHANNEL, { username: 'fixture_channel', title: 'Fixture Channel', ...extra });
const group = () => rawChannel(GROUP, { broadcast: false, megagroup: true, title: 'Fixture Channel chat' });

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1, 12, 0, 0);
  gw = makeTestGateway({ now: () => clock });
  gw.config.toolsets = ALL;
  user_a = await gw.client('user_a', ALL);
  gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, chats: [channel()], users: [] }));
  gw.tg.on('messages.GetDiscussionMessage', (req: { msgId: number }) => ({
    messages: [rawMessage(GROUP, 3000 + req.msgId, { fwdFrom: { savedFromMsgId: req.msgId } })],
    chats: [group()],
    users: [],
  }));
  gw.tg.on('messages.SendMessage', () => ({ className: 'Updates', updates: [{ className: 'UpdateMessageID', id: 7777 }] }));
});

afterEach(async () => {
  await user_a.close();
  gw.cleanup();
  vi.useRealTimers();
});

const approvals = () => gw.services.writeGate.approvals;
/** Telegram error as the gateway receives it after teleproto. */
const telegramError = (message: string, method: string): GatewayError =>
  classifyError(RPCMessageToError({ errorCode: 400, errorMessage: message } as never, { className: method } as never));
const store = () => gw.services.writeGate.store;
const approvalIdOf = (text: string): string => text.match(/approval_id (ap_[0-9a-f]+)/)![1]!;
/** The owner's agent confirms only after the owner agrees. */
const confirm = (approvalId: string, extra: Record<string, unknown> = {}) => user_a.call('tg_confirm', { approval_id: approvalId, ...extra });

describe('two-step writes: preview and tg_confirm', () => {
  it('tg_reply sends nothing before confirmation by the owner agent', async () => {
    const reply = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'Agreed, the market is overheated.' });
    expect(reply.isError).toBe(false);
    const approvalId = approvalIdOf(reply.text);
    // Preview: action, account, and exact outgoing text.
    expect(reply.text).toContain('Nothing has been done in Telegram yet');
    expect(reply.text).toContain('Reply in the comments of post https://t.me/fixture_channel/10');
    expect(reply.text).toContain('Account: agent (@agent_acc)');
    expect(reply.text).toContain('Text, exactly as it will be sent:\nAgreed, the market is overheated.');
    expect(reply.text).toContain(`Only after the owner clearly agrees, call tg_confirm with approval_id ${approvalId}`);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);

    const done = await confirm(approvalId);
    expect(done.isError).toBe(false);
    expect(done.text).toBe('Done: Sent: https://t.me/fixture_channel/10?comment=7777');
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.message).toBe('Agreed, the market is overheated.');
    expect(sent.peer.className).toBe('InputPeerChannel');
    expect(String(sent.peer.channelId)).toBe(String(GROUP));
    expect(sent.replyTo.replyToMsgId).toBe(3010);
    expect(gw.tg.last('messages.SendMessage').options).toMatchObject({ write: true });
    expect(store().getApproval(approvalId)).toMatchObject({ state: 'executed', result: { summary: 'Sent: https://t.me/fixture_channel/10?comment=7777', message_id: 7777 } });
  });

  it('another user cannot confirm an invisible request', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    const user_b = await gw.client('user_b', ALL);
    const denied = await user_b.call('tg_confirm', { approval_id: approvalId });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('Error: NOT_FOUND');
    expect((await user_b.call('tg_confirm', { action: 'reject', approval_id: approvalId })).text).toContain('Error: NOT_FOUND');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('pending');
    await user_b.close();
  });

  it('repeated confirmation sends once', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    await Promise.all([confirm(approvalId), confirm(approvalId)]);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
    const again = await confirm(approvalId);
    expect(again.text).toContain(`Request ${approvalId} is already executed: Sent:`);
    expect(again.text).toContain('Nothing was done by this call');
    expect((await confirm(approvalId, { action: 'reject' })).text).toContain('already executed');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
  });

  it('the owner replaces wording at confirmation', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'agent draft' })).text);
    const done = await confirm(approvalId, { text: 'my text' });
    expect(done.isError).toBe(false);
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('my text');
    expect(store().getApproval(approvalId)!.payload).toMatchObject({ text: 'my text', editedByOwner: true });

    // Join actions have no message text to replace.
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    const joinId = approvalIdOf((await user_a.call('tg_join', { ref: '@fixture_channel' })).text);
    const wrong = await confirm(joinId, { text: 'hello' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('no text to replace');
    expect(store().getApproval(joinId)!.state).toBe('pending');
  });

  it('reject cancels without sending and permits another draft', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    const rejected = await confirm(approvalId, { action: 'reject' });
    expect(rejected.text).toContain(`Request ${approvalId} is rejected. Nothing was done in Telegram.`);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('rejected');
    expect((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'different text' })).isError).toBe(false);
  });

  it('allows repeated post replies but prevents a second pending draft', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'first' })).text);
    const again = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'second' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain(`A reply to this post is already prepared (${approvalId})`);

    expect((await confirm(approvalId)).isError).toBe(false);
    // After sending the first reply, the same user may reply again.
    const second = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'second' });
    expect(second.isError, second.text).toBe(false);
    expect((await confirm(approvalIdOf(second.text))).isError).toBe(false);
    // So may another user of the shared account.
    const user_b = await gw.client('user_b', ALL);
    const third = await user_b.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'me too', account: 'agent' });
    expect(third.isError, third.text).toBe(false);
    await user_b.close();

    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(2);
    expect(store().writesSince('agent', 'reply', 0)).toBe(2);
  });

  it('comment URLs target that comment and stay in the post thread', async () => {
    gw.tg.on('channels.GetMessages', (req: { id: Array<{ id: number }> }) => ({
      messages: req.id.map(({ id }) =>
        id === 45
          ? rawMessage(GROUP, 45, { message: 'comment on post 10', replyTo: { replyToMsgId: 3010 } })
          : rawMessage(GROUP, id, { message: 'message from another thread', replyTo: { replyToMsgId: 999, replyToTopId: 777 } }),
      ),
      chats: [group()],
      users: [],
    }));
    const drafted = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10?comment=45', text: 'agreed' });
    expect(drafted.isError, drafted.text).toBe(false);
    expect(drafted.text).toContain('Reply to comment #45 under post #10 of @fixture_channel is prepared.');
    expect(drafted.text).toContain('Reply to comment https://t.me/fixture_channel/10?comment=45 under post https://t.me/fixture_channel/10');

    // A post reply is a distinct action and can be prepared separately.
    const toPost = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'general comment' });
    expect(toPost.isError, toPost.text).toBe(false);
    // A second draft for the same comment remains forbidden.
    const dup = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10?comment=45', text: 'again' });
    expect(dup.text).toContain('A reply to this comment is already prepared');

    expect((await confirm(approvalIdOf(drafted.text))).text).toBe('Done: Sent: https://t.me/fixture_channel/10?comment=7777');
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.replyTo.replyToMsgId).toBe(45);
    expect(sent.replyTo.topMsgId).toBe(3010);
    expect(sent.peer.className).toBe('InputPeerChannel');
    expect(() => sent.getBytes()).not.toThrow();

    await confirm(approvalIdOf(toPost.text));
    const root = gw.tg.last('messages.SendMessage').request;
    expect(root.replyTo.replyToMsgId).toBe(3010);
    expect(root.replyTo.topMsgId).toBeUndefined();

    // Reject comments belonging to another thread.
    const foreign = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10?comment=46', text: 'off topic' });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('Comment 46 not found under post 10');
  });

  it('disables link previews unless explicitly requested', async () => {
    const plain = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'see https://example.com' });
    expect(plain.text).not.toContain('Link preview');
    await confirm(approvalIdOf(plain.text));
    expect(gw.tg.last('messages.SendMessage').request.noWebpage).toBe(true);

    const withPreview = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/11', text: 'see https://example.com', link_preview: true });
    expect(withPreview.text).toContain('Link preview: on');
    await confirm(approvalIdOf(withPreview.text));
    expect(gw.tg.last('messages.SendMessage').request.noWebpage).toBeUndefined();

    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: BigInt(GROUP) }, chats: [group()], users: [] }));
    const sent = await user_a.call('tg_send', { chat: '@fixture_group', text: 'https://example.com', link_preview: true });
    expect(sent.text).toContain('Link preview: on');
    await confirm(approvalIdOf(sent.text));
    expect(gw.tg.last('messages.SendMessage').request.noWebpage).toBeUndefined();
  });

  it('tg_send reply_to targets a specific chat message', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: BigInt(GROUP) }, chats: [group()], users: [] }));
    gw.tg.on('channels.GetMessages', (req: { id: Array<{ id: number }> }) => ({
      messages: req.id.filter(({ id }) => id === 120).map(({ id }) => rawMessage(GROUP, id, { message: 'who is selling a bicycle?' })),
      chats: [group()],
      users: [],
    }));
    const drafted = await user_a.call('tg_send', { chat: '@fixture_group', text: 'I am selling one', reply_to: 120 });
    expect(drafted.isError, drafted.text).toBe(false);
    expect(drafted.text).toContain('in reply to message https://t.me/c/600/120');
    // The target message is untrusted and must not enter the action preview.
    expect(drafted.text).not.toContain('bicycle');
    await confirm(approvalIdOf(drafted.text));
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.replyTo.replyToMsgId).toBe(120);
    expect(() => sent.getBytes()).not.toThrow();

    const missing = await user_a.call('tg_send', { chat: '@fixture_group', text: 'anyone there?', reply_to: 999 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Error: MESSAGE_NOT_FOUND');
    expect(missing.text).toContain('Message 999 not found');

    // Without reply_to, send an ordinary message.
    const plain = await user_a.call('tg_send', { chat: '@fixture_group', text: 'hello everyone' });
    await confirm(approvalIdOf(plain.text));
    expect(gw.tg.last('messages.SendMessage').request.replyTo).toBeUndefined();
  });

  it('enforces daily reply limits even under the same post', async () => {
    for (let i = 1; i <= 20; i++) store().recordWrite({ ts: clock, userId: 'user_a', accountId: 'agent', kind: 'reply', chatKey: '-1000000000500', postId: 10, sentMessageId: i });
    const over = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'twenty-first' });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('Daily limit of 20 replies');
  });

  it('returns Telegram send errors with their codes', async () => {
    gw.tg.on('messages.SendMessage', () => {
      throw new GatewayError('WRITE_FORBIDDEN', 'The account is not allowed to write here.');
    });
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    const failed = await confirm(approvalId);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: WRITE_FORBIDDEN');
    expect(failed.text).toContain('The action was confirmed but failed: The account is not allowed to write here.');
    // Failed sends do not enter the journal or consume daily limits.
    expect(store().writesSince('agent', 'reply', 0)).toBe(0);
  });

  it('confirms exactly the outgoing text, including length and invisible-character handling', async () => {
    const tooLong = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'x'.repeat(4097) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain('the Telegram limit is 4096');

    const hidden = 'Good news' + String.fromCharCode(0x202e) + String.fromCharCode(0x200b) + ' hidden tail';
    const reply = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: hidden });
    expect(reply.text).toContain('Text, exactly as it will be sent:\nGood news hidden tail');
    await confirm(approvalIdOf(reply.text));
    // Telegram receives the same text shown in the preview.
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('Good news hidden tail');
    // Replacement text is sanitized too.
    const second = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/11', text: 'draft' });
    await confirm(approvalIdOf(second.text), { text: 'own' + String.fromCharCode(0x200b) + ' text' });
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('own text');
  });

  it('rejects expired confirmation even before housekeeping runs', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    clock += APPROVAL_TTL_MS + 1000;
    const late = await confirm(approvalId);
    expect(late.isError).toBe(true);
    expect(late.text).toContain('has expired');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('expired');
  });

  it('expires undecided requests', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    clock += APPROVAL_TTL_MS + 1000;
    expect(approvals().sweep()).toBe(1);
    expect((await confirm(approvalId)).text).toContain('already expired');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });

  it('expires after half an hour, permits new drafts, and removes old resolved requests', async () => {
    const first = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'first' });
    expect(first.text).toContain('The request expires at 2026-10-01 12:30 UTC');
    clock += APPROVAL_TTL_MS + 1000;
    // Housekeeping has not run yet, but an expired request is no longer pending.
    const second = await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'second' });
    expect(second.isError, second.text).toBe(false);
    expect((await confirm(approvalIdOf(second.text))).text).toContain('Done: Sent');
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('second');

    const count = () => Number((gw.storage.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n);
    expect(count()).toBe(2);
    clock += 8 * 24 * 60 * 60 * 1000;
    approvals().sweep();
    // Old request texts do not accumulate in the database.
    expect(count()).toBe(0);
    expect((await user_a.call('tg_confirm', {})).isError).toBe(true);
  });

  it('tg_confirm is available only in the write toolset', async () => {
    const names = async (toolsets: string[]) => {
      const client = await gw.client('user_a', toolsets);
      const list = (await client.tools()).map(t => t.name);
      await client.close();
      return list;
    };
    expect(await names(['core'])).not.toContain('tg_confirm');
    expect(await names(['core', 'write'])).toContain('tg_confirm');
    expect(await names(['core', 'discover', 'analytics', 'index'])).not.toContain('tg_confirm');
    expect(user_a.instructions()).toContain('call tg_confirm only after the owner clearly agrees');
  });

  it('tg_join prepares a join and skips chats the account already belongs to', async () => {
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    gw.tg.on('channels.JoinChannel', () => ({ className: 'Updates', updates: [] }));
    const reply = await user_a.call('tg_join', { ref: '@fixture_channel' });
    expect(reply.text).toContain('Joining is prepared');
    expect(reply.text).toContain('Join @fixture_channel (channel, 900 members)');
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(0);
    const done = await confirm(approvalIdOf(reply.text));
    expect(done.text).toContain('Done: The account joined @fixture_channel');
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(1);

    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: {}, chats: [channel({ left: false })] }));
    expect((await user_a.call('tg_join', { ref: '@fixture_channel' })).text).toContain('already a member');
  });
});

describe('reactions', () => {
  const HEART = String.fromCharCode(0x2764);
  const SELECTOR = String.fromCharCode(0xfe0f);

  beforeEach(() => {
    gw.tg.on('messages.SendReaction', () => ({ className: 'Updates', updates: [] }));
  });

  it('adds a reaction only after confirmation', async () => {
    const reply = await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10', emoji: '👍' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Set the reaction 👍 on https://t.me/fixture_channel/10');
    expect(reply.text).toContain('Account: agent (@agent_acc)');
    // Reactions have no text: the preview does not offer wording changes.
    expect(reply.text).not.toContain('other wording');
    expect(reply.text).toContain('To cancel: tg_confirm with action=reject.');
    expect(gw.tg.callsOf('messages.SendReaction')).toHaveLength(0);

    const done = await confirm(approvalIdOf(reply.text));
    expect(done.text).toBe('Done: Reaction 👍 is set on https://t.me/fixture_channel/10');
    const call = gw.tg.last('messages.SendReaction');
    expect(call.request.peer.className).toBe('InputPeerChannel');
    expect(String(call.request.peer.channelId)).toBe(String(CHANNEL));
    expect(call.request.msgId).toBe(10);
    expect(call.request.reaction.map((r: { emoticon: string }) => r.emoticon)).toEqual(['👍']);
    expect(call.options).toMatchObject({ write: true });
    // The request uses real teleproto classes and can be serialized.
    expect(() => call.request.getBytes()).not.toThrow();
    expect(store().writesSince('agent', 'react', 0)).toBe(1);
  });

  it('normalizes a keyboard heart to the form accepted by Telegram', async () => {
    const reply = await user_a.call('tg_react', { chat: '@fixture_channel', id: 10, emoji: HEART + SELECTOR });
    await confirm(approvalIdOf(reply.text));
    const sent = gw.tg.last('messages.SendReaction').request.reaction[0].emoticon as string;
    expect(sent).toBe(HEART);
    expect(sent).toHaveLength(1);
  });

  it('accepts only a single emoji as a reaction', async () => {
    for (const emoji of ['ok', '', '👍 hello', '+1']) {
      const reply = await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10', emoji });
      expect(reply.isError, emoji).toBe(true);
      expect(reply.text).toContain('A reaction is one emoji');
    }
    expect((await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10' })).text).toContain('A reaction is one emoji');
    expect(store().listApprovals('user_a', ['pending'])).toHaveLength(0);
  });

  it('remove clears a reaction without using the daily cap and does not duplicate pending requests', async () => {
    const reply = await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10', remove: true });
    expect(reply.text).toContain("Remove the account's reaction from https://t.me/fixture_channel/10");
    expect((await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10', emoji: '🔥' })).text).toContain('already prepared');
    expect((await confirm(approvalIdOf(reply.text))).text).toBe('Done: The reaction is removed from https://t.me/fixture_channel/10');
    expect(gw.tg.last('messages.SendReaction').request.reaction).toEqual([]);
    expect(store().writesSince('agent', 'react', 0)).toBe(0);
  });

  it('enforces the daily reaction cap and handles disallowed emoji', async () => {
    gw.tg.on('messages.SendReaction', () => {
      throw telegramError('REACTION_INVALID', 'messages.SendReaction');
    });
    const failed = await confirm(approvalIdOf((await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/10', emoji: '🤡' })).text));
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: INVALID_ARGUMENT');
    expect(failed.text).toContain('This reaction is not allowed here');
    expect(store().writesSince('agent', 'react', 0)).toBe(0);

    for (let i = 1; i <= 30; i++) store().recordWrite({ ts: clock, userId: 'user_a', accountId: 'agent', kind: 'react', chatKey: '-1000000000500', postId: i, sentMessageId: null });
    const limited = await user_a.call('tg_react', { link: 'https://t.me/fixture_channel/11', emoji: '👍' });
    expect(limited.isError).toBe(true);
    expect(limited.text).toContain('Daily limit of 30 reactions');
  });

});

describe('write outcomes reported by Telegram as errors', () => {
  const join = async () => {
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    return confirm(approvalIdOf((await user_a.call('tg_join', { ref: '@fixture_channel' })).text));
  };

  it('counts a join request as an outcome toward the daily cap', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('INVITE_REQUEST_SENT', 'channels.JoinChannel');
    });
    const done = await join();
    expect(done.isError).toBe(false);
    expect(done.text).toMatch(/Done: A join request to @fixture_channel .* is sent: an admin of the chat has to accept it/);
    expect(store().writesSince('agent', 'join', 0)).toBe(1);
  });

  it('closes an already-joined request successfully without using the cap', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('USER_ALREADY_PARTICIPANT', 'channels.JoinChannel');
    });
    expect((await join()).text).toContain('Done: The account is already a member of @fixture_channel');
    expect(store().writesSince('agent', 'join', 0)).toBe(0);
  });

  it('preserves actual join failures as errors', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('CHANNELS_TOO_MUCH', 'channels.JoinChannel');
    });
    const failed = await join();
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('CHANNELS_TOO_MUCH');
    expect(store().writesSince('agent', 'join', 0)).toBe(0);
  });

  it('RANDOM_ID_DUPLICATE means already delivered and does not resend', async () => {
    gw.tg.on('messages.SendMessage', () => {
      throw telegramError('RANDOM_ID_DUPLICATE', 'messages.SendMessage');
    });
    const done = await confirm(approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text));
    expect(done.text).toBe('Done: Sent');
    // The delivered message is recorded once.
    expect(store().writesSince('agent', 'reply', 0)).toBe(1);
  });

  it('does not turn a delivered message into a failure when journaling fails', async () => {
    const record = vi.spyOn(store(), 'recordWrite').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const done = await confirm(approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text));
    expect(record).toHaveBeenCalledTimes(1);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
    expect(done.text).toBe('Done: Sent: https://t.me/fixture_channel/10?comment=7777');
  });

  it('does not retry actions interrupted by a restart with unknown outcomes', async () => {
    const approvalId = approvalIdOf((await user_a.call('tg_reply', { link: 'https://t.me/fixture_channel/10', text: 'text' })).text);
    // The gateway crashed between confirmation and the Telegram response.
    expect(store().transitionApproval(approvalId, ['pending'], 'executing')).toBe(true);

    expect(approvals().recover()).toBe(1);
    expect(store().getApproval(approvalId)!.state).toBe('failed');
    const again = await confirm(approvalId);
    expect(again.text).toContain('already failed');
    expect(again.text).toContain('The outcome is unknown: check in Telegram before repeating it');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(approvals().recover()).toBe(0);
  });
});

describe('response details', () => {
  it('extracts sent message IDs from different response shapes', () => {
    expect(sentMessageId({ className: 'UpdateShortSentMessage', id: 5 })).toBe(5);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }] })).toBe(9);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }, { className: 'UpdateMessageID', id: 8 }] })).toBe(8);
    expect(sentMessageId(null)).toBeNull();
  });

  it('tg_send uses two steps for open chats and blocks private chats by default', async () => {
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) =>
      req.username === 'friend'
        ? { peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Friend' })] }
        : { peer: { className: 'PeerChannel', channelId: BigInt(GROUP) }, chats: [group()], users: [] },
    );
    const closed = await user_a.call('tg_send', { chat: '@friend', text: 'hello' });
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain('Private chats are closed by default');

    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: 'friend', effect: 'allow' });
    const drafted = await user_a.call('tg_send', { chat: '@friend', text: 'hello' });
    expect(drafted.text).toContain('Message to @friend is prepared');
    expect(drafted.text).toContain('Nothing has been done in Telegram yet');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect((await confirm(approvalIdOf(drafted.text))).text).toBe('Done: Sent');
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.message).toBe('hello');
    expect(sent.peer.className).toBe('InputPeerUser');

    const toGroup = await user_a.call('tg_send', { chat: '@fixture_group', text: 'group message' });
    expect((await confirm(approvalIdOf(toGroup.text), { text: 'different text' })).isError).toBe(false);
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('different text');
  });

  it('send mode allows messaging any person without reading conversations', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Friend' })] }));
    writePrivateMode(gw.storage, 'user_a', 'agent', 'send');

    const drafted = await user_a.call('tg_send', { chat: '@friend', text: 'hello' });
    expect(drafted.isError, drafted.text).toBe(false);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect((await confirm(approvalIdOf(drafted.text))).text).toBe('Done: Sent');
    expect(gw.tg.last('messages.SendMessage').request.peer.className).toBe('InputPeerUser');

    const read = await user_a.call('tg_read_history', { chat: '@friend' });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('Error: ACCESS_DENIED');
    expect(read.text).toContain('open for sending only');
    expect(gw.tg.callsOf('messages.GetHistory')).toHaveLength(0);

    gw.tg.on('users.GetFullUser', () => ({ fullUser: { about: null }, users: [rawUser(42, { username: 'friend' })] }));
    const card = await user_a.call('tg_resolve', { ref: '@friend' });
    expect(card.text).toContain('private chat is open for sending only');
    expect((await user_a.call('tg_status')).text).toContain('private chats: send only');

    // Another user of the same account has an independent mode.
    const user_b = await gw.client('user_b', ALL);
    expect((await user_b.call('tg_send', { chat: '@friend', text: 'hello', account: 'agent' })).text).toContain('Private chats are closed by default');
    await user_b.close();
  });

  it('open mode also allows reading conversations', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Friend' })] }));
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    writePrivateMode(gw.storage, 'user_a', 'agent', 'open');
    expect((await user_a.call('tg_read_history', { chat: '@friend' })).isError).toBe(false);
    expect((await user_a.call('tg_send', { chat: '@friend', text: 'hello' })).isError).toBe(false);
    expect((await user_a.call('tg_status')).text).toContain('private chats: open (read and send)');
  });

  it('sends nothing if private chats are closed after the preview', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Friend' })] }));
    writePrivateMode(gw.storage, 'user_a', 'agent', 'send');
    const drafted = await user_a.call('tg_send', { chat: '@friend', text: 'hello' });
    writePrivateMode(gw.storage, 'user_a', 'agent', 'closed');
    const failed = await confirm(approvalIdOf(drafted.text));
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: ACCESS_DENIED');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });

  it('reads daily caps from configuration, with 0 meaning unlimited', () => {
    const person = (id: number) => ({ accountId: 'agent', peerKey: String(id), kind: 'user' as const, accessHash: '1', username: null, title: null, meta: {}, updatedAt: 0 });
    const record = (g: TestGateway, n: number): void => {
      for (let i = 1; i <= n; i++) g.services.writeGate.store.recordWrite({ ts: clock, userId: 'user_a', accountId: 'agent', kind: 'send', chatKey: String(i), postId: null, sentMessageId: i });
    };

    const tight = makeTestGateway({ now: () => clock, writeLimits: { newDialogsPerDay: 2 } });
    record(tight, 2);
    expect(() => tight.services.writeGate.write.assertCanMessage('agent', person(99))).toThrow(/Daily limit of 2 new dialogs.*TG_MCP_LIMIT_NEW_DIALOGS/);
    // Other caps retain their defaults.
    expect(tight.services.writeGate.write.dailyLimits).toEqual({ repliesPerDay: 20, newDialogsPerDay: 2, joinsPerDay: 5, reactionsPerDay: 30 });
    tight.cleanup();

    const free = makeTestGateway({ now: () => clock, writeLimits: { newDialogsPerDay: 0, reactionsPerDay: 0 } });
    record(free, 40);
    for (let i = 0; i < 40; i++) free.services.writeGate.store.recordWrite({ ts: clock, userId: 'user_a', accountId: 'agent', kind: 'react', chatKey: '-1000000000500', postId: i, sentMessageId: null });
    expect(() => free.services.writeGate.write.assertCanMessage('agent', person(99))).not.toThrow();
    expect(() => free.services.writeGate.write.assertCanReact('agent')).not.toThrow();
    free.cleanup();
  });

  it('tg_status reports daily write caps', async () => {
    const text = (await user_a.call('tg_status')).text;
    expect(text).toContain('Write limits per account per day: replies 20, new dialogs 5, joins 5, reactions 30.');
    expect(text).toContain('private chats: closed, except the ones the owner opened');
  });

  it('caps new private conversations per day', () => {
    const write = gw.services.writeGate.write;
    const person = (id: number) => ({ accountId: 'agent', peerKey: String(id), kind: 'user' as const, accessHash: '1', username: null, title: null, meta: {}, updatedAt: 0 });
    for (let i = 1; i <= 5; i++) store().recordWrite({ ts: clock, userId: 'user_a', accountId: 'agent', kind: 'send', chatKey: String(i), postId: null, sentMessageId: i });
    expect(() => write.assertCanMessage('agent', person(99))).toThrow(/Daily limit of 5 new dialogs/);
    // An existing conversation can continue.
    expect(() => write.assertCanMessage('agent', person(3))).not.toThrow();
    // Another account has an independent cap.
    expect(() => write.assertCanMessage('user_a', person(99))).not.toThrow();
  });
});
