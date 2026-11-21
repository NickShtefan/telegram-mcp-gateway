#!/usr/bin/env node
// Owner-side live qualification. Build the exact candidate before running this script.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { terminalIo as io } from '../../dist/cli/io.js';
import { addUser } from '../../dist/cli/admin.js';
import { loginAccount } from '../../dist/core/auth.js';
import { parsePeerKey, toBotApiChatId } from '../../dist/core/chatId.js';
import { defaultClientFactory } from '../../dist/core/clientPool.js';
import { loadConfig, loadSessionSecret, requireApiCredentials } from '../../dist/core/config.js';
import { seal } from '../../dist/core/crypto.js';
import { peerKeyOfPeer, toInputChannel, toInputPeer } from '../../dist/core/entities.js';
import { acquireLock } from '../../dist/core/lock.js';
import { createLogger } from '../../dist/core/log.js';
import { createMcpServer } from '../../dist/mcp/server.js';
import { createRuntime } from '../../dist/runtime.js';
import { buildServices } from '../../dist/services/index.js';
import { markupFor } from '../../dist/services/specialPayload.js';
import { sentMessageId } from '../../dist/services/write.js';
import { openStorage } from '../../dist/storage/sqlite.js';

const args = process.argv.slice(2);
const resume = args.at(-1) === '--resume';
if (resume) args.pop();
const [sha, channelName, channelId, requestedBot] = args;
const root = join(homedir(), '.tg-mcp-live');
const credentials = join(root, 'state');
const state = join(root, 'bot-state');
const userId = 'keyboard_live';
const accountId = 'keyboard_bot';
const receiptPath = join(state, 'keyboard-result.json');
const journalPath = join(state, 'keyboard-in-progress.json');
const log = createLogger('keyboard-live', { level: 'warn' });
const quiet = createLogger('keyboard-auth', { level: 'silent' });
const first = [[{ text: 'Telegram', url: 'https://telegram.org/' }]];
const next = [[{ text: 'Telegram FAQ', url: 'https://telegram.org/faq' }]];

function check(value, message) { if (!value) throw new Error(message); }
function privatePath(path, directory) {
  const info = lstatSync(path);
  check(info.uid === process.getuid() && !(info.mode & 0o077) &&
    (directory ? info.isDirectory() : info.isFile() && info.nlink === 1), 'Unsafe local live-test path.');
}
function save(path, payload) {
  writeFileSync(path + '.next', JSON.stringify(payload, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(path + '.next', path);
}
const postLink = id => 'https://t.me/' + channelName.slice(1) + '/' + id;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function idOf(peer) {
  if (peer?.className === 'InputChannel' || peer?.className === 'InputPeerChannel') return toBotApiChatId(String(peer.channelId));
  return null;
}

process.umask(0o077);
check(process.getuid && args.length <= 4 && /^[a-f0-9]{40}$/.test(sha ?? '') && /^@[a-z0-9_]{4,32}$/i.test(channelName ?? '') &&
  typeof channelId === 'string' && parsePeerKey(channelId).kind === 'channel',
  'Usage: node scripts/checks/channel-keyboard-live.mjs FULL_SHA @channel NUMERIC_CHANNEL_ID [@expected_bot] [--resume]');
check(resume || io.interactive, 'Run the initial qualification in the owner Terminal.');
privatePath(root, true);
privatePath(credentials, true);
privatePath(join(credentials, '.env'), false);
if (!existsSync(state)) mkdirSync(state, { mode: 0o700 });
privatePath(state, true);
for (const file of ['session.key', 'gateway.sqlite', 'gateway.sqlite-shm', 'gateway.sqlite-wal']) {
  if (existsSync(join(state, file))) privatePath(join(state, file), false);
}

let runtime, storage, lock, services, server, sdk, pending;
const receipt = { sha, channel: { username: channelName, id: channelId }, stage: 'starting' };
try {
  lock = await acquireLock(state);
  if (resume) {
    privatePath(journalPath, false);
    privatePath(receiptPath, false);
    pending = JSON.parse(readFileSync(journalPath, 'utf8'));
    const previous = JSON.parse(readFileSync(receiptPath, 'utf8'));
    check(pending.channelId === channelId && previous.channel?.id === channelId &&
      Number.isSafeInteger(pending.id) && pending.id > 0 && previous.post === postLink(pending.id) &&
      previous.stage === 'failed' && previous.phase === 'publish',
    'Resume requires the original published fixture before any keyboard edit.');
  } else {
    check(!existsSync(journalPath), 'A prior live write needs read-back before creating another fixture.');
  }
  save(receiptPath, receipt);
  const app = requireApiCredentials(loadConfig({ TG_MCP_HOME: credentials }));
  const config = loadConfig({ TG_MCP_HOME: state, TG_API_ID: String(app.apiId), TG_API_HASH: app.apiHash });
  check(config.home === state && config.dbPath === join(state, 'gateway.sqlite'), 'Unexpected bot profile location.');
  const secret = loadSessionSecret(state, {});
  storage = openStorage(config.dbPath);
  if (!storage.sessions.get(accountId)) {
    check(!resume, 'The original bot session is required to resume.');
    receipt.stage = 'bot_login';
    save(receiptPath, receipt);
    console.log('Bot-only test session for ' + channelName + ' on ' + sha.slice(0, 7));
    const botToken = (await io.prompt('BotFather token (hidden): ', { hidden: true })).trim();
    await loginAccount({
      factory: defaultClientFactory, ...app, botToken, accountId, log: quiet,
      prompts: { code: async () => { throw new Error('Unexpected code prompt'); }, password: async () => { throw new Error('Unexpected password prompt'); } },
      persist(result) {
        if (requestedBot) check('@' + result.identity.username?.toLowerCase() === requestedBot.toLowerCase(), 'The supplied token belongs to another bot.');
        storage.transaction(() => {
          storage.accounts.upsert({ id: accountId, ...result.identity, status: 'active' });
          storage.sessions.put(accountId, seal(result.session, secret));
        });
      },
    });
  }
  const actor = storage.accounts.get(accountId);
  check(actor?.status === 'active' && actor.tgUserId &&
    (!requestedBot || '@' + actor.username?.toLowerCase() === requestedBot.toLowerCase()), 'The saved bot session does not match the requested bot.');
  if (!storage.users.get(userId)) addUser(storage, { id: userId, accounts: [accountId] });
  storage.users.update(userId, { managedWrites: true });
  runtime = createRuntime(config, { storage, sessionSecret: secret, log });
  const tg = runtime.tg;
  const invoke = tg.invoke.bind(tg);
  const allowed = new Set(['users.GetUsers', 'contacts.ResolveUsername', 'channels.GetParticipant', 'channels.GetMessages',
    'messages.SendMessage', 'messages.EditMessage']);
  let permit;
  tg.invoke = (id, request, options = {}) => {
    check(id === accountId && allowed.has(request.className), 'Unexpected live RPC.');
    if (request.peer || request.channel) check(idOf(request.peer ?? request.channel) === channelId, 'Unexpected channel.');
    if (request.className === 'contacts.ResolveUsername') check(request.username.toLowerCase() === channelName.slice(1).toLowerCase(), 'Unexpected username.');
    if (request.className === 'users.GetUsers') check(request.id.length === 1 && request.id[0].className === 'InputUserSelf', 'Unexpected user lookup.');
    if (request.className === 'messages.SendMessage' || request.className === 'messages.EditMessage') {
      check(permit?.(request), 'Write differs from the approved live test.');
      permit = undefined;
    }
    return invoke(id, request, { ...options, expectedTelegramUserId: actor.tgUserId });
  };

  receipt.stage = 'channel_preflight';
  save(receiptPath, receipt);
  const resolved = await tg.invoke(accountId, new Api.contacts.ResolveUsername({ username: channelName.slice(1) }));
  const channel = storage.entities.get(accountId, channelId);
  check(peerKeyOfPeer(resolved.peer) === channelId && channel?.meta.broadcast, 'The username does not resolve to the approved broadcast channel.');
  const [me] = await tg.invoke(accountId, new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
  check(me?.className === 'User' && me.bot && String(me.id) === actor.tgUserId, 'The live session must be the named bot.');
  const rights = await tg.invoke(accountId, new Api.channels.GetParticipant({ channel: toInputChannel(channel), participant: new Api.InputPeerSelf() }));
  check(rights.participant.className === 'ChannelParticipantAdmin' && rights.participant.adminRights?.postMessages, 'The bot needs posting rights in the approved channel.');
  services = buildServices(runtime, { ownerToolsets: true });
  ({ server } = createMcpServer({ services, principal: services.access.principalOf(userId), toolsets: ['core', 'write'], version: sha.slice(0, 7), log }));
  sdk = new Client({ name: 'channel-keyboard-live', version: '1' });
  const [agent, gateway] = InMemoryTransport.createLinkedPair();
  await server.connect(gateway);
  await sdk.connect(agent);

  async function call(name, args, inspectError = false) {
    const result = await sdk.callTool({ name, arguments: args });
    if (result.isError && !inspectError) throw new Error(result.content.map(item => item.text ?? '').join(' ').slice(0, 360));
    return result.structuredContent;
  }
  const text = pending?.text ?? 'URL keyboard live check [' + randomBytes(5).toString('hex') + ']';
  const { approvals, write, store } = services.writeGate;
  const fixtureKind = 'prepare_keyboard_live_fixture';
  let id;
  if (pending) {
    const confirmed = store.getApproval(pending.approval);
    check(confirmed?.kind === fixtureKind && confirmed.state === 'executed' && confirmed.accountId === accountId &&
      confirmed.userId === userId && confirmed.payload.chatKey === channelId && confirmed.payload.value === text &&
      same(confirmed.payload.rows, first) && confirmed.result?.message_id === pending.id,
    'The original fixture approval does not match the resume journal.');
    id = pending.id;
    receipt.fixture_sha = pending.sha;
  } else {
    console.log(JSON.stringify({ bot: '@' + actor.username, channel: receipt.channel, text, initialButtons: first, replacementButtons: next, finalButtons: [] }, null, 2));
    check((await io.prompt('Approve publishing one test post, changing its URL keyboard, and clearing the keyboard? [yes/no] ')).trim() === 'yes',
      'Live writes were declined.');
    const access = () => toInputPeer(write.requirePostWriteAccess(userId, { accountId, chatKey: channelId, postId: 1 }));
    const markup = markupFor(first);
    const randomId = bigInt(randomBytes(8).readBigInt64LE().toString());
    approvals.register(fixtureKind, async approval => {
      check(approval.userId === userId && approval.accountId === accountId && approval.payload.chatKey === channelId &&
        approval.payload.value === text && same(approval.payload.rows, first), 'Wrong fixture approval.');
      permit = request => request.className === 'messages.SendMessage' && idOf(request.peer) === channelId &&
        request.message === text && request.replyMarkup.getBytes().equals(markup.getBytes());
      const updates = await tg.invoke(accountId, new Api.messages.SendMessage({ peer: access(), message: text, randomId,
        noWebpage: true, replyMarkup: markup }), { write: true, singleAttempt: true, beforeInvoke: access });
      return { summary: 'Published the dedicated keyboard fixture.', data: { message_id: sentMessageId(updates, String(randomId)) } };
    });
    const fixture = approvals.request({ userId, accountId, kind: fixtureKind, title: 'Publish the approved keyboard test post.',
      payload: { chatKey: channelId, value: text, rows: first } });
    save(journalPath, { sha, channelId, text, approval: fixture.id });
    receipt.stage = 'publish';
    save(receiptPath, receipt);
    await call('tg_confirm', { approval_id: fixture.id });
    id = store.getApproval(fixture.id)?.result?.message_id;
    check(Number.isInteger(id) && id > 0, 'Telegram did not return a verifiable fixture message ID. Inspect the journal; do not publish again.');
    save(journalPath, { sha, channelId, id, text, approval: fixture.id });
  }
  receipt.stage = 'publish';
  receipt.post = postLink(id);

  const request = { account: accountId, chat: channelName, id };
  async function observe(expectedRows) {
    const current = await write.readPostEditState(userId, { accountId, chatKey: channelId, postId: id }, actor.tgUserId);
    const post = current.post;
    const view = await call('tg_get_message', { ...request, view: 'special' });
    check(post.message === text && !(post.entities?.length) && (!post.media || post.media.className === 'MessageMediaEmpty') &&
      same(view.keyboard ?? [], expectedRows), 'Telegram read-back does not match the test post or its URL keyboard.');
    return { available: view.available, reason: view.reason, out: !!post.out, from: post.fromId?.className ?? 'absent' };
  }
  receipt.initial = await observe(first);
  save(receiptPath, receipt);
  check(receipt.initial.available, 'The bot-authored test post cannot enter the keyboard edit path: ' + receipt.initial.reason);

  async function edit(label, before, rows) {
    receipt.stage = label;
    save(receiptPath, receipt);
    const preview = await call('tg_edit_post', { ...request, op: 'edit_keyboard', special_options_json: JSON.stringify({ rows }) });
    check(preview.status === 'preview' && preview.op === 'edit_keyboard' && preview.account === accountId &&
      preview.chat === channelId && preview.message_id === id && preview.telegram_user_id === actor.tgUserId &&
      same(preview.before, before) && same(preview.after, rows), 'Keyboard preview differs from the approved test.');
    console.log(JSON.stringify({ stage: label, message: receipt.post, before, after: rows, approval: preview.approval_id }));
    const expected = markupFor(rows).getBytes();
    permit = rpc => rpc.className === 'messages.EditMessage' && rpc.id === id && idOf(rpc.peer) === channelId &&
      rpc.replyMarkup?.getBytes().equals(expected) && rpc.message == null && rpc.entities == null && rpc.media == null && rpc.scheduleDate == null;
    let result = await call('tg_confirm', { approval_id: preview.approval_id }, true);
    if (result?.outcome === 'outcome_unknown' && !result.retry_after) result = await call('tg_confirm', { approval_id: preview.approval_id, action: 'status' }, true);
    check(result?.outcome === 'verified' && result.differences?.length === 0 && result.message_id === id,
      'Keyboard edit was not verified: ' + JSON.stringify({ outcome: result?.outcome, differences: result?.differences, telegram_code: result?.telegram_code }));
    await observe(rows);
    receipt[label] = { outcome: result.outcome, differences: result.differences };
    save(receiptPath, receipt);
  }

  await edit('change', first, next);
  await edit('clear', next, []);
  receipt.stage = 'verified';
  save(receiptPath, receipt);
  writeFileSync(journalPath, JSON.stringify({ sha, channelId, id, outcome: 'verified' }) + '\n', { mode: 0o600 });
  renameSync(journalPath, join(state, 'keyboard-last-run.json'));
  console.log(JSON.stringify(receipt));
} catch (error) {
  const phase = pending && !['change', 'clear', 'verified'].includes(receipt.stage) ? 'publish' : receipt.stage;
  if (pending?.id && !receipt.post) receipt.post = postLink(pending.id);
  const message = phase === 'bot_login' ? 'Bot login did not complete.' : String(error.message ?? error).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 440);
  if (lock) save(receiptPath, { ...receipt, stage: 'failed', phase, message });
  console.error(message);
  process.exitCode = 1;
} finally {
  if (sdk) await sdk.close().catch(() => {});
  if (server) await server.close().catch(() => {});
  services?.jobs.stop();
  if (runtime) await runtime.close().catch(() => {});
  storage?.close();
  if (lock) await lock.release().catch(() => {});
}
