import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';
import bigInt from 'big-integer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';
import { GatewayError } from '../../core/errors.js';

const link = 'https://t.me/fixture_channel/42';
const oldUrl = 'https://t.me/old';
const newUrl = 'https://t.me/new';
const args = { link, op: 'replace_link_url', old_url: oldUrl, new_url: newUrl };
const text = '  👩‍💻 here\nagain here \u200b https://t.me/old  ';
const channel = rawChannel(500, { username: 'fixture_channel' });
const factcheck = new Api.FactCheck({ hash: bigInt(123), needCheck: true });
const request = (client: TestClient, extra: Record<string, unknown> = {}) => client.call('tg_edit_post', { ...args, ...extra });
let gw: TestGateway;
let client: TestClient;
let post: Record<string, unknown>;
let entities: Api.TypeMessageEntity[];
const confirm = (id: string, extra: Record<string, unknown> = {}) => client.call('tg_confirm', { approval_id: id, ...extra });
async function prepare() {
  const result = await request(client);
  expect(result.structured?.status, result.text).toBe('preview');
  return result.structured!.approval_id as string;
}

beforeEach(async () => {
  gw = makeTestGateway({ ownerToolsets: true });
  gw.storage.users.update('user_a', { managedWrites: true });
  client = await gw.client('user_a', ['core', 'write']);
  entities = [
    new Api.MessageEntityBold({ offset: text.indexOf('here'), length: 4 }),
    new Api.MessageEntityTextUrl({ offset: text.indexOf('here'), length: 4, url: oldUrl }),
    new Api.MessageEntityUrl({ offset: text.indexOf(oldUrl), length: oldUrl.length }),
  ];
  post = rawMessage(500, 42, { message: text, post: true, pinned: true, entities });
  gw.tg.on('contacts.ResolveUsername', () => ({ peer: { channelId: 500n }, chats: [channel] }));
  gw.tg.on('channels.GetMessages', () => ({ messages: [post], chats: [channel] }));
  gw.tg.on('channels.GetParticipant', () => ({ participant: { className: 'ChannelParticipantCreator' } }));
  gw.tg.on('messages.EditMessage', req => {
    post.entities = req.entities;
    post.message = req.message;
    post.editDate = 123;
    return { className: 'Updates', updates: [] };
  });
});
afterEach(async () => { await client.close(); gw.cleanup(); });

describe('hidden-link edit contract', () => {
  it('verifies exact text and all untouched entities and preserves legacy reads', async () => {
    const ordinary = await client.call('tg_get_message', { link });
    expect(ordinary.structured).toBeUndefined();
    const read = await client.call('tg_get_message', { link, view: 'edit' });
    expect(read.structured).toMatchObject({ view: 'edit', available: true, links: [{ url: oldUrl }] });
    expect(read.text).toContain('\\u200d');
    expect(JSON.parse(read.text.slice(read.text.indexOf('\n') + 1))).toEqual(read.structured);
    const id = await prepare();
    expect((await confirm(id, { action: 'status' })).structured).toMatchObject({ state: 'pending' });
    expect((await confirm(id, { text: 'unsafe override' })).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    post.views = 100;
    const done = await confirm(id);
    expect(done.structured, done.text).toMatchObject({ outcome: 'verified', differences: [] });
    expect(post.message).toBe(text);
    const req = gw.tg.last('messages.EditMessage').request;
    expect(req.entities[0].getBytes()).toEqual(entities[0].getBytes());
    expect(req.entities[1]).toMatchObject({ offset: text.indexOf('here'), length: 4, url: newUrl });
    expect(req.entities[2].getBytes()).toEqual(entities[2].getBytes());
    expect(req.noWebpage).toBe(true);
    expect((await confirm(id)).structured).toMatchObject({ outcome: 'verified' });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
    gw.storage.scopes.put({ userId: 'user_a', accountId: 'agent', target: '-1000000000500', effect: 'deny' });
    expect((await confirm(id, { action: 'status' })).text).toContain('ACCESS_DENIED');
  });

  it('offers distinct context and revision-bound choices without an approval', async () => {
    entities.push(new Api.MessageEntityTextUrl({ offset: text.lastIndexOf('here'), length: 4, url: oldUrl }));
    const result = await request(client);
    const candidates = result.structured!.candidates as { selector: string; context: { before: string; after: string } }[];
    expect(result.structured).toMatchObject({ status: 'choose_link' });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].selector).not.toBe(candidates[1].selector);
    expect(candidates[0].context.before).not.toBe(candidates[1].context.before);
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
    const chosen = await request(client, { selector: candidates[1].selector });
    const id = chosen.structured!.approval_id as string;
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    expect(gw.tg.last('messages.EditMessage').request.entities.map((e: { url?: string }) => e.url)).toEqual([undefined, oldUrl, undefined, newUrl]);
    expect((await request(client, { selector: candidates[0].selector })).text).toContain('EDIT_CONFLICT');
  });

  it('refuses legacy/new argument mixtures and malformed combinations before approval', async () => {
    for (const extra of [{ text: 'legacy' }, { link_preview: false }, { op: undefined, text: 'legacy' },
      { op: 'unknown' }, { extra_field: true }, { new_url: 'https://new.\u202Eexample' }]) {
      expect((await request(client, extra)).isError).toBe(true);
    }
    expect((await request(client, { old_url: 'https://t.me/missing' })).structured?.status).toBe('no_match');
    expect((await client.call('tg_get_message', { link, view: 'edit', before: 1 })).isError).toBe(true);
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
  });

  it('ignores legacy client metadata while keeping new and mixed operations strict', async () => {
    const schema = (await client.tools()).find(tool => tool.name === 'tg_edit_post')!.inputSchema;
    expect(schema.additionalProperties).not.toBe(false);
    const legacy = { link, text: 'Legacy wording', request_id: 'trace-42' };
    const preview = await client.call('tg_edit_post', legacy);
    expect(preview.isError, preview.text).toBe(false);
    const [approval] = gw.services.writeGate.store.listApprovals('user_a', ['pending']);
    expect(approval.payload).not.toHaveProperty('request_id');
    expect(gw.storage.audit.recent({ tool: 'tg_edit_post' })[0].args).not.toHaveProperty('request_id');
    expect((await confirm(approval.id)).text).toContain('Edited:');
    expect(post.message).toBe(legacy.text);
    expect((await request(client, { request_id: 'trace-42' })).isError).toBe(true);
    expect((await client.call('tg_edit_post', { ...legacy, new_url: newUrl })).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('refuses fact-checked posts, and detects a new fact check before dispatch or during read-back', async () => {
    post.factcheck = factcheck;
    const view = await client.call('tg_get_message', { link, view: 'edit' });
    expect(view.structured).toMatchObject({ available: false, reason: expect.stringContaining('fact check') });
    expect((await request(client)).isError).toBe(true);
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
    delete post.factcheck;
    const first = await prepare();
    post.factcheck = factcheck;
    expect((await confirm(first)).structured?.outcome).toBe('conflict');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    delete post.factcheck;
    const second = await prepare();
    gw.tg.on('messages.EditMessage', req => { post.entities = req.entities; post.factcheck = factcheck; return {}; });
    expect((await confirm(second)).structured).toMatchObject({ outcome: 'conflict', differences: ['factcheck'] });
  });

  it('only approves destinations that survive TL UTF-8 serialization exactly', async () => {
    for (const surrogate of ['\ud800', '\udc00']) {
      const invalid = await request(client, { new_url: newUrl + '/' + surrogate });
      expect(invalid.text).toContain('unpaired UTF-16 surrogate');
      expect(invalid.isError).toBe(true);
    }
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
    const destination = newUrl + '/🌐';
    const preview = await request(client, { new_url: destination });
    gw.tg.on('messages.EditMessage', req => {
      post.entities = req.entities.map((e: Api.TypeMessageEntity) => new BinaryReader(e.getBytes()).tgReadObject());
      return {};
    });
    expect((await confirm(preview.structured!.approval_id as string)).structured?.outcome).toBe('verified');
    expect((post.entities as Api.MessageEntityTextUrl[])[1].url).toBe(preview.structured!.new_url);
  });

  it('binds selectors and pending approvals to the active Telegram identity under the alias', async () => {
    const preview = (await request(client)).structured!;
    expect(preview.telegram_user_id).toBe('1001');
    vi.spyOn(gw.tg, 'whoami').mockResolvedValue({ tgUserId: '2002', username: 'other_admin', displayName: null });
    const stale = await request(client, { selector: preview.selector });
    expect(stale.text).toContain('EDIT_CONFLICT');
    expect((await confirm(preview.approval_id as string)).structured).toMatchObject({ outcome: 'conflict' });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    expect((await request(client)).structured?.telegram_user_id).toBe('2002');
  });

  it('requires a new preview for an unbound link plan from an earlier PR build', async () => {
    const id = await prepare();
    const store = gw.services.writeGate.store;
    const payload = { ...store.getApproval(id)!.payload };
    delete payload.telegramUserId;
    store.updateApproval(id, { payload: { ...payload, version: 1 } });
    expect((await confirm(id)).structured).toMatchObject({ state: 'failed', outcome: 'conflict' });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('keeps an uncertain edit unresolved when a different identity sees matching content', async () => {
    const id = await prepare();
    gw.tg.on('messages.EditMessage', req => {
      post.entities = req.entities;
      vi.spyOn(gw.tg, 'whoami').mockResolvedValue({ tgUserId: '2002', username: null, displayName: null });
      throw new GatewayError('TIMEOUT', 'lost reply', { outcomeUnknown: true });
    });
    expect((await confirm(id)).structured).toMatchObject({ outcome: 'outcome_unknown', read_error: 'EDIT_CONFLICT' });
    expect((await confirm(id, { action: 'status' })).structured?.outcome).toBe('outcome_unknown');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it.each(['markup', 'album', 'media', 'webpage', 'mention', 'rich'])('refuses unsupported %s without a write', async kind => {
    if (kind === 'markup') post.replyMarkup = new Api.ReplyInlineMarkup({ rows: [] });
    if (kind === 'album') post.groupedId = 42n;
    if (kind === 'rich') post.richMessage = {};
    if (kind === 'media' || kind === 'webpage') post.media = { className: kind === 'media' ? 'MessageMediaPhoto' : 'MessageMediaWebPage' };
    if (kind === 'mention') entities.push(new Api.MessageEntityUnknown({ offset: 0, length: 1 }));
    expect((await client.call('tg_get_message', { link, view: 'edit' })).structured?.available).toBe(false);
    expect((await request(client)).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('enforces read-only profiles, revocation and fresh Telegram rights', async () => {
    const readOnly = await gw.client('user_a', ['core']);
    try {
      expect((await readOnly.call('tg_get_message', { link, view: 'edit' })).structured).toMatchObject({ available: false, code: 'ACCESS_DENIED' });
    } finally { await readOnly.close(); }
    const id = await prepare();
    gw.tg.on('channels.GetParticipant', () => ({ participant: { className: 'ChannelParticipantAdmin', adminRights: { postMessages: true } } }));
    expect((await confirm(id)).structured).toMatchObject({ outcome: 'failed', code: 'WRITE_FORBIDDEN' });
    post.out = true;
    const own = await prepare();
    gw.storage.accounts.revoke('agent', 'user_a');
    expect((await confirm(own)).text).toContain('ACCESS_DENIED');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('reports a preflight conflict, and precise differences for a changed read-back', async () => {
    const first = await prepare();
    post.editDate = 456;
    expect((await confirm(first)).structured?.outcome).toBe('conflict');
    const second = await prepare();
    gw.tg.on('messages.EditMessage', req => { post.entities = req.entities; post.pinned = false; return {}; });
    const result = await confirm(second);
    expect(result.structured).toMatchObject({ outcome: 'conflict', differences: ['pinned'] });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('checks a managed profile again after preview', async () => {
    const id = await prepare();
    gw.storage.users.update('user_a', { managedWrites: false });
    expect((await confirm(id)).structured).toMatchObject({ outcome: 'failed', code: 'ACCESS_DENIED' });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('consumes an unversioned pending edit created by the pre-change server at 173fc39', async () => {
    post.message = 'Original fixture post';
    post.entities = [];
    await client.call('tg_get_message', { link }); // Same per-account channel cache as a retained installation.
    const id = 'ap_1234567890';
    gw.services.writeGate.store.createApproval({ id, userId: 'user_a', accountId: 'agent', kind: 'edit',
      payload: { accountId: 'agent', chatKey: '-1000000000500', postId: 42, text: 'Legacy proposed wording',
        revision: '35ab164e80d04bd8c1597f57499016b43f8e9560df11070fca5f91d96adcaa3d', linkPreview: false },
      preview: 'Replace the text with plain text.', expiresAt: Date.now() + 60_000 });
    expect((await confirm(id, { text: 'Legacy override after upgrade' })).text).toContain('Edited:');
    expect(gw.tg.last('messages.EditMessage').request.message).toBe('Legacy override after upgrade');
  });

  it('reconciles a lost response on read-back and a crash through read-only status', async () => {
    const first = await prepare();
    gw.tg.on('messages.EditMessage', req => {
      post.entities = req.entities;
      throw new GatewayError('TIMEOUT', 'lost reply', { outcomeUnknown: true });
    });
    expect((await confirm(first)).structured?.outcome).toBe('verified');
    post.entities = entities;
    const second = await prepare();
    const store = gw.services.writeGate.store;
    store.transitionApproval(second, ['pending'], 'executing');
    gw.services.writeGate.approvals.recover();
    expect((await confirm(second)).structured?.outcome).toBe('outcome_unknown');
    expect((await confirm(second, { action: 'status' })).structured?.outcome).toBe('outcome_unknown');
    post.entities = gw.tg.last('messages.EditMessage').request.entities;
    expect((await confirm(second, { action: 'status' })).structured?.outcome).toBe('verified');
    expect((await confirm(second)).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('verifies MESSAGE_NOT_MODIFIED instead of assuming an RPC error proves equality', async () => {
    const id = await prepare();
    gw.tg.on('messages.EditMessage', () => { throw new GatewayError('TELEGRAM_ERROR', 'same', { telegramCode: 'MESSAGE_NOT_MODIFIED' }); });
    expect((await confirm(id)).structured).toMatchObject({ outcome: 'conflict', differences: ['entities[1]'] });
    const same = await request(client, { new_url: oldUrl });
    expect((await confirm(same.structured!.approval_id as string)).structured?.outcome).toBe('no-op');
  });
});
