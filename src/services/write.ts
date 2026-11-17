/**
 * Actions: comment replies, messages, reactions, joins, and
 * inline-button presses. Preflight checks also run before the preview.
 * Telegram mutations run only through write-gateway executors
 * (writegate/index.ts), after confirmation through tg_confirm.
 *
 * Post replies: GetDiscussionMessage locates the post copy in the
 * discussion group, then SendMessage replies to that copy.
 * Conservative caps: contacting strangers is the highest-risk account
 * action (see risks.md).
 */
import { randomBytes } from 'node:crypto';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { WriteStore } from '../writegate/store.js';
import { sha256Hex } from '../core/crypto.js';
import { peerKeyOfPeer, toInputChannel, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import { buttonAt, type LocatedButton } from './buttons.js';
import type { CommentsService } from './comments.js';
import type { HistoryService } from './history.js';
import { messageLink } from './links.js';
import type { MessageDto } from './messages.js';

export interface WriteLimits {
  repliesPerDay: number;
  /** New conversations: people this account has not messaged before. */
  newDialogsPerDay: number;
  joinsPerDay: number;
  reactionsPerDay: number;
}

/**
 * Default caps are conservative gateway choices, not Telegram rules:
 * Telegram does not publish thresholds and penalizes bulk messages
 * to strangers, joins, and reactions (PEER_FLOOD, account freezes).
 * Owners override caps through TG_MCP_LIMIT_*; 0 removes a cap.
 */
export const DEFAULT_WRITE_LIMITS: WriteLimits = { repliesPerDay: 20, newDialogsPerDay: 5, joinsPerDay: 5, reactionsPerDay: 30 };

/** Checks daily caps; 0 means unlimited. */
function reached(count: number, limit: number): boolean {
  return limit > 0 && count >= limit;
}

const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);

/**
 * Reaction emoji in the form accepted by Telegram, without variation
 * selectors (keyboard hearts include them, reaction lists do not).
 */
export function normalizeReactionEmoji(raw: unknown): string {
  const emoji = typeof raw === 'string' ? raw.trim().split(VARIATION_SELECTOR).join('') : '';
  if (!emoji || emoji.length > 16 || !/^\p{Extended_Pictographic}/u.test(emoji) || /[\p{L}\p{N}\s]/u.test(emoji)) {
    throw new GatewayError('INVALID_ARGUMENT', 'A reaction is one emoji, for example a thumbs up or a heart.');
  }
  return emoji;
}

export interface WriteContext {
  userId: string;
  accountId: string;
}

/** joined: joined; requested: awaiting chat admin; already: existing membership. */
export type JoinOutcome = 'joined' | 'requested' | 'already';

export interface SentMessage {
  messageId: number | null;
  link: string | null;
}

export interface ReplyOptions {
  sendAs?: 'account' | 'channel';
  /** Reply to this comment within the post thread instead of the post itself. */
  commentId?: number;
  /** Preview the first text link; disabled by default to send exactly the approved preview. */
  linkPreview?: boolean;
}

export interface SendOptions {
  /** Reply target message ID in this chat. */
  replyToId?: number;
  linkPreview?: boolean;
}

/** Previewed button position and fingerprint. */
export interface ButtonTarget {
  messageId: number;
  row: number;
  position: number;
  fingerprint: string;
}

export interface PressOutcome {
  /** Untrusted bot callback response text, shown as a toast or alert. */
  answer: string | null;
  alert: boolean;
  /** Bot response URL; the gateway does not open it. */
  url: string | null;
  /** Button press delivered, but the bot did not answer in time (BOT_RESPONSE_TIMEOUT). */
  botSilent: boolean;
}

/** Telegram waits for delayed bot callback responses and may return BOT_RESPONSE_TIMEOUT. */
const PRESS_DEADLINE_MS = 30_000;

const BUTTON_KIND_TEXT: Record<LocatedButton['kind'], string> = {
  callback: 'a callback button',
  url: 'a link button',
  login: 'a login button',
  webapp: 'a web app button',
  switch_inline: 'an inline query button',
  game: 'a game button',
  buy: 'a payment button',
  profile: 'a profile button',
  copy: 'a copy-text button',
  disabled: 'a disabled button',
  other: 'a button of an unknown kind',
};

/** Telegram message length limit. */
export const MESSAGE_MAX_CHARS = 4096;

export function assertMessageText(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new GatewayError('INVALID_ARGUMENT', 'Message text is empty.');
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    throw new GatewayError('INVALID_ARGUMENT', `Message text is ${text.length} characters, the Telegram limit is ${MESSAGE_MAX_CHARS}.`);
  }
  return text;
}

function randomId(): bigInt.BigInteger {
  return bigInt(randomBytes(8).readBigInt64BE().toString());
}

interface UpdatesLike {
  className?: string;
  id?: number;
  updates?: Array<{ className?: string; id?: number; randomId?: { toString(): string } }>;
}

/** Sent message ID extracted from the Telegram response. */
export function sentMessageId(result: unknown, requestRandomId: string): number | null {
  const r = result as UpdatesLike | null;
  if (!r || typeof r !== 'object') return null;
  if (r.className === 'UpdateShortSentMessage' && typeof r.id === 'number') return r.id;
  for (const update of r.updates ?? []) {
    if (update?.className === 'UpdateMessageID' && update.randomId?.toString() === requestRandomId && typeof update.id === 'number') return update.id;
  }
  // Other bundled updates can describe unrelated messages, including in this same channel.
  return null;
}

function dayStart(now: number): number {
  return now - (now % 86_400_000);
}

export interface WriteServiceDeps {
  tg: Tg;
  store: WriteStore;
  comments: CommentsService;
  history: HistoryService;
  postChat(context: WriteContext, chatKey: string): EntityRecord;
  limits?: Partial<WriteLimits>;
  now?: () => number;
  log?: Logger;
}

/** Telegram accepted this random_id previously; a reconnect retry means already delivered. */
function isDuplicateSend(err: unknown): boolean {
  return isGatewayError(err) && err.telegramCode === 'RANDOM_ID_DUPLICATE';
}

export class WriteService {
  private readonly editingPosts = new Set<string>();
  private readonly limits: WriteLimits;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: WriteServiceDeps) {
    // Undefined configuration values must not overwrite defaults.
    const custom = Object.fromEntries(Object.entries(deps.limits ?? {}).filter(([, v]) => typeof v === 'number'));
    this.limits = { ...DEFAULT_WRITE_LIMITS, ...custom };
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? createLogger('write');
  }

  /** Effective daily caps per account; 0 means unlimited. */
  get dailyLimits(): WriteLimits {
    return { ...this.limits };
  }

  /**
   * Journal only after the action succeeds. A storage failure must not turn
   * a delivered message into an error that prompts an agent to resend it.
   */
  private record(entry: Parameters<WriteStore['recordWrite']>[0]): void {
    try {
      this.deps.store.recordWrite(entry);
    } catch (err) {
      this.log.error('could not record a completed write', { kind: entry.kind, chat: entry.chatKey, error: (err as Error).message });
    }
  }

  private async sendMessage(accountId: string, request: Api.messages.SendMessage): Promise<number | null> {
    try {
      return sentMessageId(await this.deps.tg.invoke(accountId, request, { write: true }), String(request.randomId));
    } catch (err) {
      if (isDuplicateSend(err)) return null;
      throw err;
    }
  }

  /** Daily post-reply cap; the owner decides how often to reply to the same post. */
  assertCanReply(accountId: string): void {
    if (reached(this.deps.store.writesSince(accountId, 'reply', dayStart(this.now())), this.limits.repliesPerDay)) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.repliesPerDay} replies for this account is reached.`);
    }
  }

  /** Replies to a channel post or a comment within its thread. */
  async reply(context: WriteContext, channel: EntityRecord, postId: number, text: string, options: ReplyOptions = {}): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanReply(context.accountId);
    const root = await this.deps.comments.root(context.accountId, channel, postId);

    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(root.discussion),
        message,
        // Preserve comment-thread membership by passing its root as topMsgId.
        replyTo: options.commentId
          ? new Api.InputReplyToMessage({ replyToMsgId: options.commentId, topMsgId: root.rootId })
          : new Api.InputReplyToMessage({ replyToMsgId: root.rootId }),
        randomId: randomId(),
        noWebpage: options.linkPreview === true ? undefined : true,
        sendAs: options.sendAs === 'channel' ? toInputPeer(channel) : undefined,
      }),
    );

    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'reply',
      chatKey: channel.peerKey,
      postId,
      sentMessageId: messageId,
    });
    return {
      messageId,
      link: messageId !== null ? messageLink({ username: channel.username, peerKey: channel.peerKey, messageId: postId, commentId: messageId }) : null,
    };
  }

  /** Checks whether a new conversation may be started with this person. */
  assertCanMessage(accountId: string, peer: EntityRecord): void {
    if (peer.kind !== 'user') return;
    if (peer.meta.bot === true) return;
    if (this.deps.store.hasWrittenTo(accountId, peer.peerKey)) return;
    if (reached(this.deps.store.newDialogsSince(accountId, dayStart(this.now())), this.limits.newDialogsPerDay)) {
      throw new GatewayError(
        'LIMIT_REACHED',
        `Daily limit of ${this.limits.newDialogsPerDay} new dialogs for this account is reached: messages to people the account has not written to before. The limit is a gateway setting (TG_MCP_LIMIT_NEW_DIALOGS), only the owner can change it.`,
      );
    }
  }

  /** Sends a message to a chat or person. */
  async send(context: WriteContext, peer: EntityRecord, text: string, options: SendOptions = {}): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanMessage(context.accountId, peer);
    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(peer),
        message,
        randomId: randomId(),
        noWebpage: options.linkPreview === true ? undefined : true,
        replyTo: options.replyToId ? new Api.InputReplyToMessage({ replyToMsgId: options.replyToId }) : undefined,
      }),
    );
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'send',
      chatKey: peer.peerKey,
      postId: null,
      sentMessageId: messageId,
    });
    return {
      messageId,
      link: messageId !== null && peer.kind === 'channel' ? messageLink({ username: peer.username, peerKey: peer.peerKey, messageId }) : null,
    };
  }

  /** Read the editable content only. Views, reactions and expiring file references are not revisions. */
  async inspectPost(context: WriteContext, chatKey: string, id: number) {
    const chat = this.deps.postChat(context, chatKey);
    if (chat.kind !== 'channel' || chat.meta.broadcast !== true) {
      throw new GatewayError('INVALID_ARGUMENT', 'Choose a post in a broadcast channel.');
    }
    const page = await this.deps.history.byIds(context.accountId, chat, [id]);
    // GetMessages can refresh the channel username used in scope rules.
    const currentChat = this.deps.postChat(context, chatKey);
    const post = (page.raw as Array<Api.Message & { invertMedia?: boolean }>).find(m => m.id === id && peerKeyOfPeer(m.peerId) === chat.peerKey);
    if (!post) throw new GatewayError('MESSAGE_NOT_FOUND', `Post #${id} no longer exists in this channel, or the ID is wrong.`);
    if (post.className !== 'Message' || !post.post || post.richMessage || post.replyMarkup) {
      throw new GatewayError('INVALID_ARGUMENT', 'Choose a published text post or media caption without buttons or rich-message content.');
    }
    const media = post.media;
    const caption = media?.className === 'MessageMediaPhoto' || media?.className === 'MessageMediaDocument';
    const webpage = media?.className === 'MessageMediaWebPage';
    if (media && !caption && !webpage && media.className !== 'MessageMediaEmpty') {
      throw new GatewayError('INVALID_ARGUMENT', 'Only text posts and photo or document captions can be edited.');
    }
    const mediaId = media?.className === 'MessageMediaPhoto' ? media.photo?.id
      : media?.className === 'MessageMediaDocument' ? media.document?.id
      : webpage && 'id' in media.webpage ? media.webpage.id : undefined;
    const text = post.message ?? '';
    const invertMedia = post.invertMedia === true;
    const revision = sha256Hex(JSON.stringify([
      text, post.editDate, (post.entities ?? []).map(entity => entity.getBytes().toString('hex')),
      media?.className, mediaId?.toString(), invertMedia,
    ]));
    return { text, revision, caption, webpage, invertMedia, chat: currentChat };
  }

  async editPost(context: WriteContext, chatKey: string, id: number, revision: string, text: string, linkPreview: boolean) {
    const message = assertMessageText(text);
    // Separate approvals and even separate gateway accounts may target the same published post.
    const key = `${chatKey}/${id}`;
    if (this.editingPosts.has(key)) throw new GatewayError('LIMIT_REACHED', 'Another edit of this post is in progress. Read it again before preparing another edit.');
    this.editingPosts.add(key);
    try {
      const current = await this.inspectPost(context, chatKey, id);
      const chat = this.deps.postChat(context, chatKey);
      const link = messageLink({ username: chat.username, peerKey: chatKey, messageId: id });
      if (current.revision !== revision) {
        throw new GatewayError('INVALID_ARGUMENT', 'The post changed since the preview. Read it again and prepare a fresh edit.');
      }
      try {
        await this.deps.tg.invoke(context.accountId, new Api.messages.EditMessage({
          peer: toInputPeer(chat), id, message, entities: [], noWebpage: linkPreview ? undefined : true,
          invertMedia: current.invertMedia || undefined,
        }), { write: true });
      } catch (err) {
        if (isGatewayError(err) && err.telegramCode === 'MESSAGE_NOT_MODIFIED') return { changed: false, link };
        throw err;
      }
      this.record({ ts: this.now(), ...context, kind: 'edit', chatKey: chat.peerKey, postId: id, sentMessageId: null });
      return { changed: true, link };
    } finally {
      this.editingPosts.delete(key);
    }
  }

  /** Daily reaction cap; reacting to every consecutive post can look like manipulation. */
  assertCanReact(accountId: string): void {
    if (reached(this.deps.store.writesSince(accountId, 'react', dayStart(this.now())), this.limits.reactionsPerDay)) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.reactionsPerDay} reactions for this account is reached.`);
    }
  }

  /** Adds a message reaction; null removes the account's reaction. */
  async react(context: WriteContext, chat: EntityRecord, messageId: number, emoji: string | null): Promise<void> {
    if (emoji !== null) this.assertCanReact(context.accountId);
    await this.deps.tg.invoke(
      context.accountId,
      new Api.messages.SendReaction({
        peer: toInputPeer(chat),
        msgId: messageId,
        reaction: emoji !== null ? [new Api.ReactionEmoji({ emoticon: normalizeReactionEmoji(emoji) })] : [],
      }),
      { write: true },
    );
    if (emoji === null) return;
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'react',
      chatKey: chat.peerKey,
      postId: messageId,
      sentMessageId: null,
    });
  }

  /**
   * Only callback buttons can be pressed. The gateway does not open links,
   * web apps, sign-in flows, payments, or games, or enter a 2FA password.
   */
  async findButton(accountId: string, chat: EntityRecord, messageId: number, row: number, position: number): Promise<{ button: LocatedButton; message: MessageDto }> {
    const found = await this.deps.history.byIds(accountId, chat, [messageId]);
    const message = found.messages[0];
    if (!message) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${messageId} not found in this chat: it was deleted or the id is wrong.`);
    if (message.buttons.length === 0) throw new GatewayError('INVALID_ARGUMENT', `Message ${messageId} has no inline buttons.`);
    const button = buttonAt(found.raw[0], row, position);
    if (!button) {
      throw new GatewayError('INVALID_ARGUMENT', `Message ${messageId} has no button at row ${row}, position ${position}. tg_get_message lists its buttons as row.position.`);
    }
    if (button.kind !== 'callback' || button.data === null) {
      throw new GatewayError(
        'INVALID_ARGUMENT',
        `This is ${BUTTON_KIND_TEXT[button.kind]}. The gateway presses only callback buttons and never opens links, web apps, logins, payments or games: the owner can press it in Telegram.`,
      );
    }
    if (button.needsPassword) {
      throw new GatewayError('INVALID_ARGUMENT', 'This button asks for the 2FA password of the account. The gateway never enters it: the owner can press the button in Telegram.');
    }
    return { button, message };
  }

  /**
   * Rereads a callback button's message before pressing. A changed button
   * blocks execution; callback bytes come only from the message.
   */
  async press(context: WriteContext, chat: EntityRecord, target: ButtonTarget): Promise<PressOutcome> {
    const found = await this.deps.history.byIds(context.accountId, chat, [target.messageId]);
    if (found.messages.length === 0) {
      throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${target.messageId} is gone: it was deleted. Nothing was pressed.`);
    }
    const button = buttonAt(found.raw[0], target.row, target.position);
    if (!button || button.fingerprint !== target.fingerprint || button.data === null || button.needsPassword) {
      throw new GatewayError('NOT_FOUND', 'The button changed since the preview: the message was edited. Nothing was pressed. Read the message again and prepare a new request.');
    }

    try {
      const reply = (await this.deps.tg.invoke(
        context.accountId,
        new Api.messages.GetBotCallbackAnswer({ peer: toInputPeer(chat), msgId: target.messageId, data: button.data }),
        { write: true, deadlineMs: PRESS_DEADLINE_MS },
      )) as { message?: string; alert?: boolean; url?: string } | null;
      return {
        answer: typeof reply?.message === 'string' && reply.message !== '' ? reply.message : null,
        alert: reply?.alert === true,
        url: typeof reply?.url === 'string' && reply.url !== '' ? reply.url : null,
        botSilent: false,
      };
    } catch (err) {
      // Delivery with a bot response timeout is an outcome, not an execution failure.
      if (isGatewayError(err) && err.telegramCode === 'BOT_RESPONSE_TIMEOUT') return { answer: null, alert: false, url: null, botSilent: true };
      throw err;
    }
  }

  /** Joins public chats or invites without solving gatekeeper-bot challenges. */
  async join(context: WriteContext, target: { chat?: EntityRecord; inviteHash?: string }): Promise<{ chatKey: string | null; outcome: JoinOutcome }> {
    if (reached(this.deps.store.writesSince(context.accountId, 'join', dayStart(this.now())), this.limits.joinsPerDay)) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.joinsPerDay} joins for this account is reached.`);
    }
    let chatKey: string | null = null;
    let outcome: JoinOutcome = 'joined';
    try {
      if (target.inviteHash) {
        await this.deps.tg.invoke(context.accountId, new Api.messages.ImportChatInvite({ hash: target.inviteHash }), { write: true });
      } else if (target.chat && target.chat.kind === 'channel') {
        chatKey = target.chat.peerKey;
        await this.deps.tg.invoke(context.accountId, new Api.channels.JoinChannel({ channel: toInputChannel(target.chat) }), { write: true });
      } else {
        throw new GatewayError('INVALID_ARGUMENT', 'Only channels, supergroups and invite links can be joined.');
      }
    } catch (err) {
      // Telegram reports these completed outcomes as errors.
      const code = isGatewayError(err) ? err.telegramCode : undefined;
      if (code === 'INVITE_REQUEST_SENT') outcome = 'requested';
      else if (code === 'USER_ALREADY_PARTICIPANT') return { chatKey, outcome: 'already' };
      else throw err;
    }
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'join',
      chatKey: chatKey ?? `invite:${target.inviteHash}`,
      postId: null,
      sentMessageId: null,
    });
    return { chatKey, outcome };
  }
}
