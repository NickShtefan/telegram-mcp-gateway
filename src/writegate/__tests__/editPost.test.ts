import { Api } from 'teleproto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { classifyError } from '../../core/errors.js';

const link = 'https://t.me/fixture_channel/42';
const channelKey = '-1000000000500';
const toolsets = ['core', 'write'];
let gw: TestGateway;
let client: TestClient;
let post: Record<string, unknown>;
const draft = (extra: Record<string, unknown> = {}) => client.call('tg_edit_post', { link, text: 'New text', ...extra });
const approve = (id: string, options: Record<string, unknown> = {}) => client.call('tg_confirm', { approval_id: id, ...options });
function approval(text: string): string {
  expect(text).toMatch(/approval_id ap_[0-9a-f]+/);
  return text.match(/approval_id (ap_[0-9a-f]+)/)![1]!;
}

beforeEach(async () => {
  gw = makeTestGateway();
  client = await gw.client('user_a', toolsets);
  post = rawMessage(500, 42, { post: true, message: 'Original text', out: false });
  gw.tg.on('contacts.ResolveUsername', () => ({ peer: { channelId: 500n }, chats: [rawChannel(500, { username: 'fixture_channel' })] }));
  gw.tg.on('channels.GetMessages', () => ({ messages: [post] }));
  gw.tg.on('messages.EditMessage', () => ({ className: 'Updates', updates: [] }));
});
afterEach(async () => { await client.close(); gw.cleanup(); });

describe('published channel posts', () => {
  it('publishes directly to the channel and returns a link usable for a confirmed in-place edit', async () => {
    gw.tg.on('messages.SendMessage', () => ({ className: 'UpdateShortSentMessage', id: 42 }));
    const publish = await client.call('tg_send', { chat: '@fixture_channel', text: 'Original text' });
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect((await approve(approval(publish.text))).text).toContain(link);
    expect(gw.tg.last('messages.SendMessage').request.replyTo).toBeUndefined();
    const preview = await draft();
    expect(preview.text).toMatch(/<<<TG:\w+\nOriginal text\nTG:\w+>>>/);
    expect(preview.text).toContain(link);
    expect(preview.text).toContain('New text');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);

    const id = approval(preview.text);
    const other = await gw.client('user_b', toolsets);
    try { expect((await other.call('tg_confirm', { approval_id: id })).text).toContain('NOT_FOUND'); }
    finally { await other.close(); }
    post.views = 1000;
    expect((await approve(id, { text: 'Owner wording' })).text).toContain('Edited: ' + link);
    expect(gw.tg.last('messages.EditMessage')).toMatchObject({ accountId: 'agent', options: { write: true },
      request: { peer: { className: 'InputPeerChannel' }, id: 42, message: 'Owner wording', noWebpage: true, entities: [] } });
    expect(String(gw.tg.last('messages.EditMessage').request.peer.channelId)).toBe('500');
    expect((await approve(id)).text).toContain('already executed');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
    expect(gw.services.writeGate.store.writesSince('agent', 'edit', 0)).toBe(1);
  });

  it('edits a photo caption while preserving its media and position', async () => {
    post.media = { className: 'MessageMediaPhoto', photo: { className: 'Photo', id: 17n } };
    post.invertMedia = true;
    const preview = await client.call('tg_edit_post', { chat: '@fixture_channel', id: 42, text: 'New caption' });
    expect(preview.text).toContain('Replace the media caption');
    expect((await approve(approval(preview.text))).isError).toBe(false);
    const request = gw.tg.last('messages.EditMessage').request;
    expect(request.media).toBeUndefined();
    expect(request.invertMedia).toBe(true);
  });

  it('preserves the link card setting by default and discloses removal', async () => {
    post.media = { className: 'MessageMediaWebPage', webpage: { className: 'WebPage', id: 7n, url: 'https://example.com' } };
    expect((await draft({ link_preview: false })).text).toContain('Remove the existing link preview');
    const preview = await draft();
    expect(preview.text).toContain('Link preview: on');
    expect((await approve(approval(preview.text))).isError).toBe(false);
    expect(gw.tg.last('messages.EditMessage').request.noWebpage).toBeUndefined();
  });

  it.each(['text', 'formatting', 'deleted', 'peer', 'scope', 'grant'])('blocks confirmation after a change to %s', async change => {
    const id = approval((await draft()).text);
    if (change === 'text') post.message = 'Another admin edited this';
    if (change === 'formatting') post.entities = [new Api.MessageEntityBold({ offset: 0, length: 4 })];
    if (change === 'deleted') post = { className: 'MessageEmpty', id: 42 };
    if (change === 'peer') post = rawMessage(999, 42, { post: true });
    if (change === 'scope') gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: channelKey, effect: 'deny' });
    if (change === 'grant') gw.storage.accounts.revoke('agent', 'user_a');
    expect((await approve(id)).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it.each([{ link: link + '?comment=5' }, { link: 'https://t.me/fixture_channel/7/42' }, { link, id: 99 },
    { chat: link, id: 42 }, { chat: '@fixture_channel' }])('refuses ambiguous or non-post targets %j', async target => {
    expect((await client.call('tg_edit_post', { ...target, text: 'New' })).isError).toBe(true);
    expect(gw.tg.callsOf('channels.GetMessages')).toHaveLength(0);
  });

  it('can cancel a pending approval after losing account access', async () => {
    const id = approval((await draft()).text);
    gw.storage.accounts.revoke('agent', 'user_a');
    expect((await approve(id, { action: 'reject' })).text).toContain('rejected');
    gw.storage.accounts.grant('agent', 'user_a');
    expect((await approve(id)).text).toContain('already rejected');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('claims a post across accounts before the confirmation read', async () => {
    const first = approval((await draft()).text);
    const second = approval((await draft({ account: 'user_a', text: 'Other wording' })).text);
    let started!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    gw.tg.on('channels.GetMessages', async () => {
      started();
      await resume;
      return { messages: [post] };
    });
    const confirming = approve(first);
    try {
      await reading;
      expect((await approve(second)).text).toContain('Another edit of this post is in progress');
    } finally { release(); }
    expect((await confirming).isError).toBe(false);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it.each(['preview', 'confirm'])('honors an owner deny discovered during the %s read', async stage => {
    const id = stage === 'confirm' ? approval((await draft()).text) : null;
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: 'renamed_channel', effect: 'deny' });
    gw.tg.on('channels.GetMessages', () => ({ messages: [post], chats: [rawChannel(500, { username: 'renamed_channel' })] }));
    const reply = id ? await approve(id) : await draft();
    expect(reply.text).toContain('ACCESS_DENIED');
    expect(reply.text).not.toContain('Original text');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('refuses a supergroup and unsupported channel messages', async () => {
    post.post = false;
    expect((await draft()).isError).toBe(true);
    post.post = true;
    post.media = { className: 'MessageMediaPoll' };
    expect((await draft()).isError).toBe(true);
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { channelId: 700n }, chats: [rawChannel(700, { broadcast: false, megagroup: true })] }));
    expect((await draft({ link: 'https://t.me/fixture_group/42' })).text).toContain('broadcast channel');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('resolves a reassigned channel handle before preparing a new write', async () => {
    await draft();
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { channelId: 800n }, chats: [rawChannel(800, { username: 'fixture_channel' })] }));
    post = rawMessage(800, 42, { post: true, message: 'Current channel' });
    const edit = await draft();
    expect(edit.text).toContain('Current channel');
    expect(edit.text).toContain('channel ID -1000000000800');
    const publish = await client.call('tg_send', { chat: '@fixture_channel', text: 'New announcement' });
    expect(gw.services.writeGate.approvals.status(approval(publish.text), 'user_a').payload.chatKey).toBe('-1000000000800');
  });

  it('surfaces Telegram edit permissions and treats an identical edit as a no-op', async () => {
    gw.tg.on('messages.EditMessage', () => { throw classifyError({ errorMessage: 'CHAT_ADMIN_REQUIRED' }, { write: true }); });
    expect((await approve(approval((await draft()).text))).text).toContain('WRITE_FORBIDDEN');
    gw.tg.on('messages.EditMessage', () => { throw classifyError({ errorMessage: 'MESSAGE_NOT_MODIFIED' }, { write: true }); });
    expect((await approve(approval((await draft({ text: 'Original text' })).text))).text).toContain('Already up to date');
    expect(gw.services.writeGate.store.writesSince('agent', 'edit', 0)).toBe(0);
  });
});
