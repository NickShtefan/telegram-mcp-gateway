/**
 * Write gateway for actions that change Telegram state. Each action starts
 * as a request with a preview and executes after `tg_confirm`.
 * The gateway does not write or launch anything autonomously.
 */
import { GatewayError } from '../core/errors.js';
import { ScopePolicy, type ScopeAction } from '../policy/scopes.js';
import type { Runtime } from '../runtime.js';
import type { CommentsService } from '../services/comments.js';
import type { HistoryService } from '../services/history.js';
import { WriteService } from '../services/write.js';
import type { EntityRecord } from '../storage/port.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Approvals } from './approvals.js';
import { WriteStore } from './store.js';

export interface WriteGate {
  store: WriteStore;
  approvals: Approvals;
  write: WriteService;
}

export interface WriteGateDeps {
  runtime: Runtime;
  comments: CommentsService;
  history: HistoryService;
  now?: () => number;
}

export function buildWriteGate(deps: WriteGateDeps): WriteGate {
  const { runtime } = deps;
  const { storage, log } = runtime;
  if (!(storage instanceof SqliteStorage)) {
    throw new GatewayError('UNAVAILABLE', 'The write gate needs the SQLite storage.');
  }
  const now = deps.now ?? (() => Date.now());
  const store = new WriteStore(storage, now);
  const approvals = new Approvals({ store, log: log.child('approvals'), now });
  const write = new WriteService({ tg: runtime.tg, store, comments: deps.comments, history: deps.history, limits: runtime.config.writeLimits, now, log: log.child('write') });

  // Recheck scopes at execution: between preview and confirmation,
  // the owner may have closed the chat or changed private-chat access.
  const scopes = new ScopePolicy(storage);
  const chatOf = (approval: { userId: string }, accountId: string, chatKey: string, action: ScopeAction): EntityRecord => {
    const chat = storage.entities.get(accountId, chatKey);
    if (!chat) throw new GatewayError('CHAT_NOT_FOUND', `Chat ${chatKey} is no longer known to account ${accountId}.`);
    scopes.assertAllowed(approval.userId, accountId, chat, action);
    return chat;
  };

  approvals.register(
    'reply',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey: string; postId: number; text: string; sendAs?: 'account' | 'channel'; commentId?: number; linkPreview?: boolean };
      const sent = await write.reply({ userId: approval.userId, accountId: p.accountId }, chatOf(approval, p.accountId, p.chatKey, 'read'), p.postId, p.text, {
        sendAs: p.sendAs,
        commentId: p.commentId,
        linkPreview: p.linkPreview,
      });
      return { summary: sent.link ? `Sent: ${sent.link}` : 'Sent', data: { link: sent.link, message_id: sent.messageId } };
    },
    { editable: true },
  );

  approvals.register(
    'send',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey: string; text: string; replyToId?: number; linkPreview?: boolean };
      const sent = await write.send({ userId: approval.userId, accountId: p.accountId }, chatOf(approval, p.accountId, p.chatKey, 'write'), p.text, {
        replyToId: p.replyToId,
        linkPreview: p.linkPreview,
      });
      return { summary: sent.link ? `Sent: ${sent.link}` : 'Sent', data: { message_id: sent.messageId } };
    },
    { editable: true },
  );

  approvals.register('react', async approval => {
    const p = approval.payload as { accountId: string; chatKey: string; messageId: number; emoji: string | null; where: string };
    await write.react({ userId: approval.userId, accountId: p.accountId }, chatOf(approval, p.accountId, p.chatKey, 'read'), p.messageId, p.emoji);
    return { summary: p.emoji ? `Reaction ${p.emoji} is set on ${p.where}` : `The reaction is removed from ${p.where}` };
  });

  approvals.register('join', async approval => {
    const p = approval.payload as { accountId: string; chatKey?: string; inviteHash?: string; label: string };
    const joined = await write.join(
      { userId: approval.userId, accountId: p.accountId },
      { chat: p.chatKey ? chatOf(approval, p.accountId, p.chatKey, 'read') : undefined, inviteHash: p.inviteHash },
    );
    if (joined.outcome === 'requested') return { summary: `A join request to ${p.label} is sent: an admin of the chat has to accept it.`, data: { outcome: joined.outcome } };
    if (joined.outcome === 'already') return { summary: `The account is already a member of ${p.label}.`, data: { outcome: joined.outcome } };
    return { summary: `The account joined ${p.label}. If a gatekeeper bot asks for a check there, tell the owner: such checks usually expire within a minute.`, data: { outcome: joined.outcome } };
  });

  approvals.register('press', async approval => {
    const p = approval.payload as { accountId: string; chatKey: string; messageId: number; row: number; position: number; fingerprint: string; label: string; where: string };
    const pressed = await write.press({ userId: approval.userId, accountId: p.accountId }, chatOf(approval, p.accountId, p.chatKey, 'read'), {
      messageId: p.messageId,
      row: p.row,
      position: p.position,
      fingerprint: p.fingerprint,
    });
    const what = `The button "${p.label}" under ${p.where} is pressed`;
    if (pressed.botSilent) {
      return { summary: `${what}, but the bot did not answer in time. Read the chat to see whether anything changed; do not press it again blindly.`, data: { bot_silent: true } };
    }
    // Bot responses are untrusted text returned inside the untrusted-content boundary.
    return { summary: `${what}.`, data: { bot_answer: pressed.answer, bot_alert: pressed.alert, bot_url: pressed.url } };
  });

  return { store, approvals, write };
}
