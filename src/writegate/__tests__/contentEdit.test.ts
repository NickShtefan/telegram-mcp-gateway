import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';
import bigInt from 'big-integer';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';
import { GatewayError } from '../../core/errors.js';

const link = 'https://t.me/fixture_channel/42';
const channel = rawChannel(500, { username: 'fixture_channel' });
let gw: TestGateway;
let client: TestClient;
let post: Record<string, unknown>;
let messageLimit: number;
let premium: boolean;
const wire = (x: Api.TypeMessageEntity) => new BinaryReader(x.getBytes()).tgReadObject() as Api.TypeMessageEntity;
const draft = (op: string, extra = {}) => client.call('tg_edit_post', { link, op, ...extra });
const approve = (approval_id: unknown, extra = {}) => client.call('tg_confirm', { approval_id, ...extra });
const inspect = () => client.call('tg_get_message', { link, view: 'content' });

function photo(id = 23, reference = 'first', spoiler = true) {
  return new Api.MessageMediaPhoto({
    spoiler, photo: new Api.Photo({
      id: bigInt(id), accessHash: bigInt(55),
      fileReference: Buffer.from(reference), date: 123, dcId: 1, sizes: []
    })
  });
}
function setPost(message: string, entities: Api.TypeMessageEntity[] = [], extra = {}) {
  post = rawMessage(500, 42, { post: true, message, entities, ...extra });
}
beforeEach(async () => {
  gw = makeTestGateway();
  client = await gw.client('user_a', ['core', 'write']);
  messageLimit = 4096;
  premium = false;
  setPost('hello world');
  gw.tg.on('contacts.ResolveUsername', () => ({ peer: { channelId: 500n }, chats: [channel] }));
  gw.tg.on('channels.GetMessages', () => ({ messages: [post], chats: [channel] }));
  gw.tg.on('channels.GetParticipant', () => ({ participant: { className: 'ChannelParticipantCreator' } }));
  gw.tg.on('help.GetConfig', () => ({ messageLengthMax: messageLimit, captionLengthMax: 3 }));
  gw.tg.on('users.GetUsers', () => [{ className: 'User', id: bigInt(1001), premium }]);
  gw.tg.on('help.GetAppConfig', () => ({
    className: 'help.AppConfig',
    config: { className: 'JsonObject', value: [
      { key: 'caption_length_limit_default', value: { className: 'JsonNumber', value: 4 } },
      { key: 'caption_length_limit_premium', value: { className: 'JsonNumber', value: 8 } },
    ] },
  }));
  gw.tg.on('messages.EditMessage', req => {
    const decoded = new BinaryReader(req.getBytes()).tgReadObject();
    post.message = decoded.message;
    post.entities = decoded.entities.map((e: Api.TypeMessageEntity) => e.className === 'InputMessageEntityMentionName' && 'userId' in e.userId
      ? new Api.MessageEntityMentionName({ offset: e.offset, length: e.length, userId: e.userId.userId }) : e);
    post.editDate = 999;
    return {};
  });
});
afterEach(async () => { await client.close(); gw.cleanup(); });

describe('content edits through MCP', () => {
  it('rejects mixed schemas, repeated URL expansion beyond the limit, and clearing a text post', async () => {
    const url = 'https://a.tld';
    setPost(url + ' ' + url, [new Api.MessageEntityUrl({ offset: 0, length: url.length }),
      new Api.MessageEntityUrl({ offset: url.length + 1, length: url.length })]);
    messageLimit = 30;
    for (const [op, extra] of [
      ['replace_visible_url', { old_url: url, new_url: 'https://example.org/long', all: true }],
      ['replace_range', { find: url, replacement: 'x', text: 'legacy' }],
      ['replace_link_url', { old_url: url, new_url: url, find: 'x' }],
      ['clear_caption', {}],
    ] as const) expect((await draft(op, extra)).isError).toBe(true);
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
  });

  it('rechecks access after fetching the account configuration and before storing a preview', async () => {
    gw.tg.on('help.GetConfig', () => {
      gw.storage.accounts.revoke('agent', 'user_a');
      return { messageLengthMax: 4096 };
    });
    const p = await draft('replace_range', { find: 'hello', replacement: 'Hello' });
    expect(p.text).toContain('ACCESS_DENIED');
    expect(p.text).not.toContain('hello world');
    expect(gw.services.writeGate.store.listApprovals('user_a', ['pending'])).toEqual([]);
  });

  it('replaces one exact occurrence and shifts nested/manual spans by UTF-16 units', async () => {
    const value = '  OLD 👩‍💻 OLD\nlink  ';
    const anchor = value.indexOf('link');
    setPost(value, [new Api.MessageEntityTextUrl({ offset: anchor, length: 4, url: 'https://example.org' }),
    new Api.MessageEntityItalic({ offset: anchor, length: 4 })]);
    const options = { find: 'OLD', replacement: '🌟xx' };
    const pick = await draft('replace_range', options);
    expect(pick.structured?.status).toBe('choose_range');
    const choices = pick.structured!.candidates as { selector: string }[];
    const preview = await draft('replace_range', { ...options, selector: choices[1].selector });
    expect(preview.structured?.occurrences).toHaveLength(1);
    expect((await approve(preview.structured!.approval_id, { text: 'override' })).isError).toBe(true);
    expect((await approve(preview.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(post.message).toBe('  OLD 👩‍💻 🌟xx\nlink  ');
    expect(post.entities).toMatchObject([{ offset: anchor + 1, length: 4, url: 'https://example.org' }, { offset: anchor + 1, length: 4 }]);
    expect((await draft('replace_range', { ...options, selector: choices[0].selector })).isError).toBe(true);
  });

  it('rejects ambiguous crossings, broken graphemes and unsupported entity types', async () => {
    setPost('ABCD👩‍💻', [new Api.MessageEntityBold({ offset: 0, length: 2 })]);
    expect((await draft('replace_range', { find: 'BCD', replacement: 'Z' })).isError).toBe(true);
    expect((await draft('replace_range', { find: '👩', replacement: 'Z' })).structured?.status).toBe('no_match');
    expect((await draft('replace_content', { replacement: '👩‍💻', entities_json: '[{"type":"bold","offset":0,"length":2}]' })).isError).toBe(true);
    post.entities = [new Api.MessageEntityDiffInsert({ offset: 0, length: 1 })];
    expect((await inspect()).structured?.available).toBe(false);
    expect((await draft('replace_range', { find: 'ABC', replacement: 'Z' })).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('adds formatting within a span, splits only the selected style, and refuses code nesting', async () => {
    setPost('abcdef', [new Api.MessageEntityBold({ offset: 0, length: 6 })]);
    const add = await draft('add_format', { find: 'cd', style: 'italic' });
    expect((await approve(add.structured!.approval_id)).structured?.outcome).toBe('verified');
    const remove = await draft('remove_format', { find: 'cd', style: 'bold' });
    expect((await approve(remove.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect((await inspect()).structured?.entities).toEqual(expect.arrayContaining([
      { type: 'bold', offset: 0, length: 2 }, { type: 'bold', offset: 4, length: 2 }, { type: 'italic', offset: 2, length: 2 }]));
    expect((await draft('add_format', { find: 'cd', style: 'code' })).isError).toBe(true);
  });

  it('only replaces exact visible URL entities and enumerates every approved change', async () => {
    const old = 'https://a.tld', next = 'https://bbb.tld';
    const value = old + ' x ' + old + ' ' + old;
    setPost(value, [new Api.MessageEntityUrl({ offset: 0, length: old.length }),
    new Api.MessageEntityUrl({ offset: old.length + 3, length: old.length }),
    new Api.MessageEntityTextUrl({ offset: value.lastIndexOf(old), length: old.length, url: old })]);
    const options = { old_url: old, new_url: next };
    expect((await draft('replace_visible_url', options)).structured?.status).toBe('choose_range');
    const p = await draft('replace_visible_url', { ...options, all: true });
    expect(p.structured?.occurrences).toHaveLength(2);
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(post.message).toBe(next + ' x ' + next + ' ' + old);
    expect((post.entities as Api.MessageEntityTextUrl[])[2].url).toBe(old);
  });

  it('requires explicit full replacement spans, preserves attributes, and counts code points separately', async () => {
    messageLimit = 6;
    const replacement = '🌐abcdZ';
    const spans = [{ type: 'pre', offset: 0, length: 2, language: 'ts' }, { type: 'blockquote', offset: 2, length: 2, collapsed: true },
    { type: 'formatted_date', offset: 4, length: 1, date: 123, flags: ['relative'] }, { type: 'spoiler', offset: 5, length: 2 }];
    expect((await draft('replace_content', { replacement })).isError).toBe(true);
    const p = await draft('replace_content', { replacement, entities_json: JSON.stringify(spans) });
    expect(p.structured?.entities_after, p.text).toEqual(spans);
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect((await inspect()).structured?.entities).toEqual(spans);
    expect((await draft('replace_content', { replacement: replacement + 'x', entities_json: '[]' })).isError).toBe(true);
    const strip = await draft('replace_content', { replacement, entities_json: '[]' });
    expect(strip.structured?.entities_before).toHaveLength(4);
    expect((await approve(strip.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(post.entities).toEqual([]);
  });

  it('preserves mentions and custom emoji across a patch using the correct wire entity for mentions', async () => {
    setPost('A 🌐 Alice', [new Api.MessageEntityCustomEmoji({ offset: 2, length: 2, documentId: bigInt(42) }),
    new Api.MessageEntityMentionName({ offset: 5, length: 5, userId: bigInt(77) })]);
    const p = await draft('replace_range', { find: 'A ', replacement: 'Hi ' });
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    const actual = gw.tg.last('messages.EditMessage').request.entities.map(wire);
    expect(actual[1]).toMatchObject({ className: 'InputMessageEntityMentionName', offset: 6, userId: { className: 'InputUserFromMessage', msgId: 42 } });
    expect(gw.tg.callsOf('messages.GetCustomEmojiDocuments')).toHaveLength(0);
  });

  it('clears a caption explicitly, omitting media on the wire and accepting a refreshed file reference', async () => {
    setPost('hi', [new Api.MessageEntityBold({ offset: 0, length: 2 })], { media: photo(), invertMedia: true });
    expect((await inspect()).structured).toMatchObject({ available: true, field: 'caption' });
    const p = await draft('clear_caption');
    expect(p.structured).toMatchObject({ before: 'hi', after: '', entities_after: [] });
    post.media = photo(23, 'refreshed');
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    const sent = new BinaryReader(gw.tg.last('messages.EditMessage').request.getBytes()).tgReadObject();
    expect(sent.message).toBe(''); expect(sent.media).toBeFalsy(); expect(sent.invertMedia).toBe(true);
    expect((post.media as Api.MessageMediaPhoto).photo!.id.toString()).toBe('23');
  });

  it('rechecks caption limits and refuses stale attachments or a post-write attribute mismatch', async () => {
    setPost('hi', [], { media: photo() });
    const options = { replacement: '🌟'.repeat(5), entities_json: '[]' };
    expect((await draft('replace_content', options)).isError).toBe(true);
    premium = true;
    const over = await draft('replace_content', options);
    premium = false;
    expect((await approve(over.structured!.approval_id)).structured).toMatchObject({ outcome: 'failed', code: 'INVALID_ARGUMENT' });
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    const stale = await draft('clear_caption');
    post.media = photo(24);
    expect((await approve(stale.structured!.approval_id)).structured?.outcome).toBe('conflict');
    const p = await draft('clear_caption');
    gw.tg.on('messages.EditMessage', () => { post.message = ''; post.entities = []; post.media = photo(24, 'fresh', false); return {}; });
    expect((await approve(p.structured!.approval_id)).structured).toMatchObject({ outcome: 'conflict', differences: ['attachment'] });
  });

  it('uses read-only reconciliation after an interrupted content edit', async () => {
    const p = await draft('replace_range', { find: 'hello', replacement: 'Hello' });
    const id = p.structured!.approval_id;
    gw.tg.on('messages.EditMessage', req => {
      post.message = req.message;
      gw.tg.on('channels.GetMessages', () => { throw new GatewayError('UNAVAILABLE', 'fixture disconnect'); });
      throw new GatewayError('TIMEOUT', 'lost reply', { outcomeUnknown: true });
    });
    expect((await approve(id)).structured?.outcome).toBe('outcome_unknown');
    gw.tg.on('channels.GetMessages', () => ({ messages: [post] }));
    expect((await approve(id, { action: 'status' })).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('retains whitespace, combining characters and invisible characters outside the selected range', async () => {
    const original = '  e\u0301\r\n\u200b' + 'x'.repeat(20) + '  ';
    setPost(original);
    const choices = await draft('replace_range', { find: 'x', replacement: 'y' });
    expect(choices.structured).toMatchObject({ total: 20 });
    expect(choices.structured?.candidates).toHaveLength(12);
    const preview = await draft('replace_range', { find: 'x', replacement: 'y', occurrence: 19 });
    expect((await approve(preview.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(post.message).toBe(original.slice(0, -4) + 'yx  ');
  });

  it('checks newly added custom emoji eligibility and its actual Telegram fallback', async () => {
    let free = false;
    gw.tg.on('messages.GetCustomEmojiDocuments', () => [{
      className: 'Document', id: bigInt(42),
      attributes: [{ className: 'DocumentAttributeCustomEmoji', free, alt: '🌐' }]
    }]);
    const full = { replacement: '🌐', entities_json: JSON.stringify([{ type: 'custom_emoji', offset: 0, length: 2, document_id: '42' }]) };
    expect((await draft('replace_content', full)).isError).toBe(true);
    premium = true;
    expect((await draft('replace_content', { ...full, replacement: '🌟' })).isError).toBe(true);
    const p = await draft('replace_content', full);
    premium = false;
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('failed');
    free = true;
    const allowed = await draft('replace_content', full);
    expect((await approve(allowed.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('detects a document attribute change while retaining nested code inside a quote', async () => {
    const doc = (name: string) => new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt(88), accessHash: bigInt(1), fileReference: Buffer.from('ref'), size: bigInt(22),
        date: 1, dcId: 1, mimeType: 'text/plain', attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
      })
    });
    setPost('abc', [], { media: doc('before.txt') });
    const p = await draft('replace_content', {
      replacement: 'abc', entities_json: JSON.stringify([
        { type: 'code', offset: 0, length: 3 }, { type: 'blockquote', offset: 0, length: 3, collapsed: true },
      ])
    });
    expect(p.structured?.status, p.text).toBe('preview');
    post.media = doc('after.txt');
    expect((await approve(p.structured!.approval_id)).structured?.outcome).toBe('conflict');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
});
