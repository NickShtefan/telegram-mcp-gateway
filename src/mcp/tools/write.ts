/**
 * `write` toolset: comment replies, messages, reactions, chat joins,
 * and inline-button presses.
 *
 * Writes use two steps (decisions 4 and 23). A tool prepares a request
 * and returns a preview with `approval_id`; the gateway executes it after
 * `tg_confirm`, called by the agent once the owner has consented.
 */
import { z } from 'zod';
import { GatewayError, type GatewayErrorCode } from '../../core/errors.js';
import { createEnvelope, safeLabel } from '../../policy/envelope.js';
import { messageLink, parseRef } from '../../services/links.js';
import { assertMessageText, normalizeReactionEmoji } from '../../services/write.js';
import type { ApprovalRecord } from '../../writegate/store.js';
import { formatAuthor, formatDate } from '../format.js';
import { defineTool, type ToolContext, type ToolDef } from '../tool.js';
import { accountArg, chatArg, chatLabel, locateMessage, type MessageLocation } from './shared.js';

const STATE_TEXT: Record<ApprovalRecord['state'], string> = {
  pending: 'waiting for a decision',
  executing: 'being executed',
  executed: 'executed',
  rejected: 'rejected',
  expired: 'expired',
  failed: 'failed',
};

/** Write tool response: the exact proposed action and next steps. */
function confirmNote(approval: ApprovalRecord, ctx: ToolContext): string {
  const account = approval.accountId ? ctx.services.runtime.storage.accounts.get(approval.accountId) : null;
  const lines = ['Nothing has been done in Telegram yet. This is what will be done:', approval.preview];
  if (account) lines.push(`Account: ${account.id}${account.username ? ` (@${account.username})` : ''}`);
  const text = approval.payload.text;
  const hasText = typeof text === 'string' && text !== '';
  if (hasText) lines.push('Text, exactly as it will be sent:', text);
  if (approval.payload.linkPreview === true) lines.push('Link preview: on (Telegram adds a preview card for the first link in the text).');
  lines.push(
    '',
    `Show this to the owner. Only after the owner clearly agrees, call tg_confirm with approval_id ${approval.id}.`,
    // Only actions containing text permit wording changes; reactions and joins do not.
    hasText ? 'If the owner wants other wording, pass it to tg_confirm as "text". To cancel: tg_confirm with action=reject.' : 'To cancel: tg_confirm with action=reject.',
    `The request expires at ${formatDate(Math.floor(approval.expiresAt / 1000))} UTC. Do not repeat the write call itself.`,
  );
  return lines.join('\n');
}

function outcomeOf(approval: ApprovalRecord): string {
  const result = approval.result ?? {};
  if (typeof result.summary === 'string') return result.summary + botAnswerNote(result);
  if (typeof result.error === 'string') return result.error;
  return '';
}

/** Bot callback response returned inside the untrusted-content boundary. */
function botAnswerNote(result: Record<string, unknown>): string {
  const answer = typeof result.bot_answer === 'string' ? result.bot_answer : '';
  const url = typeof result.bot_url === 'string' ? result.bot_url : '';
  if (!answer && !url) return '';
  const envelope = createEnvelope();
  const lines = ['', envelope.notice()];
  if (answer) lines.push(`The bot answered${result.bot_alert === true ? ' with an alert window' : ''}:`, envelope.inline(answer, 400));
  if (url) lines.push('The bot answered with a link. The gateway does not open links:', envelope.inline(url, 300));
  return lines.join('\n');
}

/** Preview message reference: link, or message number and chat when links are unavailable. */
function messageTarget(where: MessageLocation): string {
  const link = where.commentOf
    ? messageLink({ username: where.commentOf.chat.username, peerKey: where.commentOf.chat.peerKey, messageId: where.commentOf.postId, commentId: where.messageId })
    : messageLink({ username: where.chat.username, peerKey: where.chat.peerKey, messageId: where.messageId });
  return link ?? `message #${where.messageId} in ${chatLabel(where.chat)}`;
}

const linkPreviewArg = z.boolean().optional().describe('true shows a preview card for the first link in the text. Default false.');

const tgReply = defineTool({
  name: 'tg_reply',
  toolset: 'write',
  title: 'Reply in comments to a post',
  description:
    'Prepares a reply in the comments of a channel post and returns a preview with an approval_id. Nothing is posted until tg_confirm, which you call after the owner agrees. A link to the post replies to the post itself; a link to a comment (...?comment=N, as printed by tg_get_comments) replies to that comment.',
  input: {
    link: z.string().optional().describe('t.me link to the post, or to a comment under it to reply to that comment.'),
    chat: z.string().optional().describe('Channel, when "link" is not given.'),
    id: z.number().int().positive().max(2_147_483_647).optional().describe('Post id, when "link" is not given.'),
    text: z.string().describe('Reply text, plain text, up to 4096 characters.'),
    send_as: z.enum(['account', 'channel']).optional().describe('Reply as the account (default) or as the channel, if the account is its admin.'),
    link_preview: linkPreviewArg,
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { writeGate } = ctx.services;
    const text = assertMessageText(args.text);
    const where = await locateMessage(ctx, args);
    const post = where.commentOf ?? { chat: where.chat, postId: where.messageId };
    if (post.chat.kind !== 'channel') {
      throw new GatewayError('INVALID_ARGUMENT', 'tg_reply answers in the comments of a channel post. For other chats use tg_send.');
    }

    // Reply to the linked comment, not its post; locateMessage already verified thread membership.
    const commentId = where.commentOf ? where.messageId : undefined;

    writeGate.write.assertCanReply(where.accountId);
    const waiting = writeGate.approvals.findPending(
      ctx.principal.userId,
      'reply',
      p => p.accountId === where.accountId && p.chatKey === post.chat.peerKey && p.postId === post.postId && (p.commentId ?? null) === (commentId ?? null),
    );
    if (waiting) {
      throw new GatewayError(
        'LIMIT_REACHED',
        `A reply to this ${commentId ? 'comment' : 'post'} is already prepared (${waiting.id}). Confirm it with tg_confirm (pass "text" to change the wording) or reject it there; do not prepare another one.`,
      );
    }

    const link = messageLink({ username: post.chat.username, peerKey: post.chat.peerKey, messageId: post.postId }) ?? `#${post.postId} in ${chatLabel(post.chat)}`;
    const commentLink = commentId
      ? (messageLink({ username: post.chat.username, peerKey: post.chat.peerKey, messageId: post.postId, commentId }) ?? `#${commentId}`)
      : null;
    const sendAs = args.send_as ?? 'account';
    const linkPreview = args.link_preview === true;
    const approval = writeGate.approvals.request({
      userId: ctx.principal.userId,
      accountId: where.accountId,
      kind: 'reply',
      payload: { accountId: where.accountId, chatKey: post.chat.peerKey, postId: post.postId, text, sendAs, ...(commentId ? { commentId } : {}), ...(linkPreview ? { linkPreview } : {}) },
      title: `${commentLink ? `Reply to comment ${commentLink} under post ${link}` : `Reply in the comments of post ${link}`}${sendAs === 'channel' ? ' (on behalf of the channel)' : ''}`,
    });
    const what = commentId ? `Reply to comment #${commentId} under post #${post.postId}` : `Reply to post #${post.postId}`;
    return { accountId: where.accountId, peerKey: post.chat.peerKey, text: `${what} of ${chatLabel(post.chat)} is prepared.\n${confirmNote(approval, ctx)}` };
  },
});

const tgSend = defineTool({
  name: 'tg_send',
  toolset: 'write',
  title: 'Send a message',
  description:
    'Prepares a message to a chat and returns a preview with an approval_id; nothing is sent until tg_confirm, which you call after the owner agrees. "chat" is a group, a channel where the account may post, or a person. Messages to people work only if the owner has opened that chat or allowed private messages for this account (tg_status shows the mode); in "send" mode you can write to a person but cannot read the conversation.',
  input: {
    chat: chatArg,
    text: z.string().describe('Message text, plain text, up to 4096 characters.'),
    reply_to: z.number().int().positive().max(2_147_483_647).optional().describe('Id of a message in this chat to reply to.'),
    link_preview: linkPreviewArg,
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { writeGate, history } = ctx.services;
    const text = assertMessageText(args.text);
    const accountId = ctx.account(args.account);
    const { chat } = await ctx.openChat(args.chat, accountId, 'write');
    writeGate.write.assertCanMessage(accountId, chat);

    const replyToId = args.reply_to;
    if (replyToId !== undefined) {
      // Check existence only; do not expose message text to the agent here.
      const found = await history.byIds(accountId, chat, [replyToId]);
      if (found.messages.length === 0) {
        throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${replyToId} not found in ${chatLabel(chat)}: it was deleted or the id is wrong.`);
      }
    }
    const linkPreview = args.link_preview === true;
    const replyLink = replyToId !== undefined ? messageLink({ username: chat.username, peerKey: chat.peerKey, messageId: replyToId }) : null;
    const approval = writeGate.approvals.request({
      userId: ctx.principal.userId,
      accountId,
      kind: 'send',
      payload: { accountId, chatKey: chat.peerKey, text, ...(replyToId !== undefined ? { replyToId } : {}), ...(linkPreview ? { linkPreview } : {}) },
      title: `Message to ${chatLabel(chat)}${replyToId !== undefined ? ` in reply to message ${replyLink ?? `#${replyToId}`}` : ''}`,
    });
    return { accountId, peerKey: chat.peerKey, text: `Message to ${chatLabel(chat)} is prepared.\n${confirmNote(approval, ctx)}` };
  },
});

const tgReact = defineTool({
  name: 'tg_react',
  toolset: 'write',
  title: 'React to a message',
  description:
    'Prepares an emoji reaction to a post, a message or a comment and returns a preview with an approval_id; the reaction is set only after tg_confirm, which you call after the owner agrees. remove=true takes the account\'s reaction off. Only standard emoji: custom and paid reactions are not supported.',
  input: {
    link: z.string().optional().describe('t.me link to the message (a comment link works too).'),
    chat: z.string().optional().describe('Chat, when "link" is not given.'),
    id: z.number().int().positive().max(2_147_483_647).optional().describe('Message id, when "link" is not given.'),
    emoji: z.string().optional().describe('One emoji. Required unless remove=true.'),
    remove: z.boolean().optional().describe('true removes the reaction of the account from this message.'),
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { writeGate } = ctx.services;
    const emoji = args.remove === true ? null : normalizeReactionEmoji(args.emoji);
    const where = await locateMessage(ctx, args);
    if (emoji !== null) writeGate.write.assertCanReact(where.accountId);

    const waiting = writeGate.approvals.findPending(
      ctx.principal.userId,
      'react',
      p => p.accountId === where.accountId && p.chatKey === where.chat.peerKey && p.messageId === where.messageId,
    );
    if (waiting) {
      throw new GatewayError('LIMIT_REACHED', `A reaction to this message is already prepared (${waiting.id}). Confirm or reject it with tg_confirm first.`);
    }

    const target = messageTarget(where);
    const approval = writeGate.approvals.request({
      userId: ctx.principal.userId,
      accountId: where.accountId,
      kind: 'react',
      payload: { accountId: where.accountId, chatKey: where.chat.peerKey, messageId: where.messageId, emoji, where: target },
      title: emoji !== null ? `Set the reaction ${emoji} on ${target}` : `Remove the account's reaction from ${target}`,
    });
    return { accountId: where.accountId, peerKey: where.chat.peerKey, text: `The reaction is prepared.\n${confirmNote(approval, ctx)}` };
  },
});

const tgJoin = defineTool({
  name: 'tg_join',
  toolset: 'write',
  title: 'Join a chat',
  description:
    'Prepares joining a channel or group (public or by invite link) and returns a preview with an approval_id; the account joins only after tg_confirm, which you call after the owner agrees. Joining does not pass the check of a gatekeeper bot: if the chat has one, tell the owner what it asks.',
  input: { ref: chatArg, account: accountArg },
  readOnly: false,
  handler: async (args, ctx) => {
    const { writeGate, resolver } = ctx.services;
    const accountId = ctx.account(args.account);
    const parsed = parseRef(args.ref);

    let payload: Record<string, unknown>;
    let label: string;
    if (parsed.chat.type === 'invite') {
      const invite = await resolver.invite(accountId, parsed.chat.hash);
      if (invite.member) return { accountId, text: 'The account is already a member of this chat.' };
      label = `the private chat "${safeLabel(invite.title, 60) || 'untitled'}"${invite.members ? `, ${invite.members} members` : ''}${invite.requestNeeded ? ' (joining needs an admin to accept the request)' : ''}`;
      payload = { accountId, inviteHash: parsed.chat.hash, label };
    } else {
      const { chat } = await ctx.openChat(args.ref, accountId);
      if (chat.kind !== 'channel') throw new GatewayError('INVALID_ARGUMENT', 'Only channels and supergroups can be joined.');
      const card = await resolver.card(accountId, chat);
      if (card.isMember === true) return { accountId, peerKey: chat.peerKey, text: `The account is already a member of ${chatLabel(chat)}.` };
      label = `${chatLabel(chat)} (${card.type}${card.members !== null ? `, ${card.members} members` : ''})`;
      payload = { accountId, chatKey: chat.peerKey, label };
    }

    const approval = writeGate.approvals.request({ userId: ctx.principal.userId, accountId, kind: 'join', payload, title: `Join ${label}` });
    return { accountId, text: `Joining is prepared.\n${confirmNote(approval, ctx)}` };
  },
});

const tgPressButton = defineTool({
  name: 'tg_press_button',
  toolset: 'write',
  title: 'Press an inline button',
  description:
    'Prepares pressing an inline button under a message and returns a preview with an approval_id; it is pressed only after tg_confirm, which you call after the owner agrees. "row" and "button" are the place printed by tg_get_message: 2.1 is row 2, button 1. Only callback buttons work: links, web apps, logins, payments and games are refused, and links are never opened. The answer of the bot comes back with the confirmation.',
  input: {
    link: z.string().optional().describe('t.me link to the message with the button.'),
    chat: z.string().optional().describe('Chat, when "link" is not given.'),
    id: z.number().int().positive().max(2_147_483_647).optional().describe('Message id, when "link" is not given.'),
    row: z.number().int().min(1).max(100).describe('Row of the button, counted from 1.'),
    button: z.number().int().min(1).max(100).describe('Position of the button in its row, counted from 1.'),
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { writeGate } = ctx.services;
    const where = await locateMessage(ctx, args);
    const { button, message } = await writeGate.write.findButton(where.accountId, where.chat, where.messageId, args.row, args.button);

    const waiting = writeGate.approvals.findPending(
      ctx.principal.userId,
      'press',
      p => p.accountId === where.accountId && p.chatKey === where.chat.peerKey && p.messageId === where.messageId && p.row === args.row && p.position === args.button,
    );
    if (waiting) {
      throw new GatewayError('LIMIT_REACHED', `Pressing this button is already prepared (${waiting.id}). Confirm or reject it with tg_confirm first.`);
    }

    // Bot-written labels are flattened to one line without markup in the preview.
    const label = safeLabel(button.text, 64).replace(/"/g, "'") || 'no label';
    const target = messageTarget(where);
    const approval = writeGate.approvals.request({
      userId: ctx.principal.userId,
      accountId: where.accountId,
      kind: 'press',
      payload: {
        accountId: where.accountId,
        chatKey: where.chat.peerKey,
        messageId: where.messageId,
        row: args.row,
        position: args.button,
        fingerprint: button.fingerprint,
        label,
        where: target,
      },
      title: `Press the callback button "${label}" (row ${args.row}, button ${args.button}) under ${target}, sent by ${formatAuthor(message.author, message.out)}`,
    });
    return { accountId: where.accountId, peerKey: where.chat.peerKey, text: `Pressing the button is prepared.\n${confirmNote(approval, ctx)}` };
  },
});

const tgConfirm = defineTool({
  name: 'tg_confirm',
  toolset: 'write',
  title: 'Confirm or reject a write request',
  description:
    'Second step of every write tool (tg_reply, tg_send, tg_react, tg_join, tg_press_button): those only prepare a request and return a preview with an approval_id, and nothing happens in Telegram until tg_confirm approves it. Call it only after the owner has seen the preview and clearly agreed. A request lives for 30 minutes.',
  input: {
    approval_id: z.string().describe('Request id like ap_1a2b3c4d5e, returned by the write tool.'),
    action: z.enum(['approve', 'reject']).optional().describe('approve (default) or reject.'),
    text: z.string().optional().describe("For approve: the owner's own wording that replaces the prepared text, up to 4096 characters."),
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { approvals } = ctx.services.writeGate;
    const userId = ctx.principal.userId;
    const before = approvals.status(args.approval_id, userId);
    const audit = { accountId: before.accountId, peerKey: typeof before.payload.chatKey === 'string' ? before.payload.chatKey : null };

    if (before.state !== 'pending') {
      // Repeated calls return the stored outcome without executing the action again.
      const detail = outcomeOf(before);
      return { ...audit, text: `Request ${before.id} is already ${STATE_TEXT[before.state]}${detail ? `: ${detail}` : '.'}\nNothing was done by this call.` };
    }

    if (args.action === 'reject') {
      if (args.text !== undefined) throw new GatewayError('INVALID_ARGUMENT', '"text" makes sense only with action=approve.');
      const rejected = approvals.reject(before.id, userId);
      return { ...audit, text: `Request ${rejected.id} is ${STATE_TEXT[rejected.state]}. Nothing was done in Telegram.` };
    }

    const after = await approvals.confirm(before.id, userId, args.text);
    if (after.state === 'executed') return { ...audit, text: `Done: ${outcomeOf(after)}` };
    if (after.state === 'failed') {
      const result = after.result ?? {};
      const code = (typeof result.code === 'string' ? result.code : 'TELEGRAM_ERROR') as GatewayErrorCode;
      throw new GatewayError(code, `The action was confirmed but failed: ${typeof result.message === 'string' ? result.message : outcomeOf(after)}`, {
        retryAfter: typeof result.retry_after === 'number' ? result.retry_after : undefined,
        outcomeUnknown: result.outcome_unknown === true,
      });
    }
    // A concurrent confirmation has already claimed execution.
    return { ...audit, text: `Request ${after.id} is ${STATE_TEXT[after.state]}. Call tg_confirm with this id again to read the outcome.` };
  },
});

export const WRITE_TOOLS: ToolDef[] = [tgReply, tgSend, tgReact, tgJoin, tgPressButton, tgConfirm] as unknown as ToolDef[];
