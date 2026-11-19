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
import { peerKeyOfPeer, toInputChannel, toInputPeer, toInputUser } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import { buttonAt, type LocatedButton } from './buttons.js';
import type { CommentsService } from './comments.js';
import type { HistoryService } from './history.js';
import { messageLink } from './links.js';
import type { MessageDto } from './messages.js';
import { changedEntities, differences, entityFingerprints, isCaption, postEditState, requireBoundLinkPlan, type LinkOutcome, type LinkPlan, type PostEditState, type PostTarget, type PublishedPost } from './linkEdit.js';
import { assertContentLength, type ContentPlan } from './contentEdit.js';
import { checkEntityRules, coverageEntities, describeEntity, entityOf, type Span } from './postEntities.js';

type ApprovedPostPlan = LinkPlan | ContentPlan;

function requireBoundPlan(plan: ApprovedPostPlan, readingOutcome = false) {
  if (!('op' in plan)) return requireBoundLinkPlan(plan);
  if ((plan.version !== 4 && !(readingOutcome && plan.version === 3)) || !plan.telegramUserId) throw new GatewayError('EDIT_CONFLICT', 'Prepare a fresh content preview.');
}

function observedFields(state: PostEditState, plan: ApprovedPostPlan) {
  if (!('op' in plan) || plan.version === 3) return state.fields;
  return { ...state.fields, entities: entityFingerprints(coverageEntities(state.post.entities ?? [])) };
}

interface ContentLimits {
  length: number;
  premium?: boolean;
  app?: Api.help.TypeAppConfig;
}

function appInteger(app: Api.help.TypeAppConfig, key: string, fallback: number): number {
  if (app.className !== 'help.AppConfig' || app.config.className !== 'JsonObject') {
    throw new GatewayError('UNAVAILABLE', 'Telegram returned no usable app configuration.');
  }
  const entry = app.config.value.find(v => v.key === key);
  if (!entry) return fallback;
  if (entry.value.className !== 'JsonNumber' || !Number.isSafeInteger(entry.value.value) || entry.value.value < 0) {
    throw new GatewayError('UNAVAILABLE', 'Invalid Telegram configuration for ' + key + '.');
  }
  return entry.value.value;
}

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
  profileCanWrite(userId: string): boolean;
  mentionUser(accountId: string, id: string): EntityRecord | null;
  limits?: Partial<WriteLimits>;
  now?: () => number;
  log?: Logger;
}

/** Telegram accepted this random_id previously; a reconnect retry means already delivered. */
function isDuplicateSend(err: unknown): boolean {
  return isGatewayError(err) && err.telegramCode === 'RANDOM_ID_DUPLICATE';
}

function channelEditDenial(rights: { any: boolean; own: boolean }, post: PublishedPost) {
  if (rights.any || (rights.own && post.out)) return null;
  return { code: 'WRITE_FORBIDDEN', reason: 'This Telegram account lacks editing rights for this channel post.' } as const;
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

  private async publishedPost(context: WriteContext, chatKey: string, id: number, expectedTelegramUserId?: string) {
    const chat = this.deps.postChat(context, chatKey);
    if (chat.kind !== 'channel' || chat.meta.broadcast !== true) {
      throw new GatewayError('INVALID_ARGUMENT', 'Choose a post in a broadcast channel.');
    }
    const page = await this.deps.history.byIds(context.accountId, chat, [id], { expectedTelegramUserId });
    // GetMessages can refresh the channel username used in scope rules.
    const currentChat = this.deps.postChat(context, chatKey);
    const post = (page.raw as PublishedPost[]).find(m => m.id === id && peerKeyOfPeer(m.peerId) === chat.peerKey);
    if (!post) throw new GatewayError('MESSAGE_NOT_FOUND', `Post #${id} no longer exists in this channel, or the ID is wrong.`);
    if (post.className !== 'Message' || !post.post || !currentChat.meta.broadcast) {
      throw new GatewayError('INVALID_ARGUMENT', 'Choose a published broadcast channel post.');
    }
    return { chat: currentChat, post };
  }

  /** Keep the original revision format for approvals persisted by earlier releases. */
  async inspectPost(context: WriteContext, chatKey: string, id: number) {
    const { post, chat } = await this.publishedPost(context, chatKey, id);
    if (post.richMessage || post.replyMarkup) {
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
    return { text, revision, caption, webpage, invertMedia, chat };
  }

  async editPost(context: WriteContext, chatKey: string, id: number, revision: string, text: string, linkPreview: boolean) {
    const message = assertMessageText(text);
    // Separate approvals and even separate gateway accounts may target the same published post.
    const key = this.claimEdit(chatKey, id);
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

  private claimEdit(chatKey: string, id: number): string {
    const key = `${chatKey}/${id}`;
    if (this.editingPosts.has(key)) throw new GatewayError('LIMIT_REACHED', 'Another edit of this post is in progress. Read it again before preparing another edit.');
    this.editingPosts.add(key);
    return key;
  }

  async readPostEditState(userId: string, target: PostTarget, expectedTelegramUserId?: string) {
    const context = { userId, accountId: target.accountId };
    this.deps.postChat(context, target.chatKey);
    const telegramUserId = expectedTelegramUserId ?? (await this.deps.tg.whoami(target.accountId)).tgUserId;
    const { post } = await this.publishedPost(context, target.chatKey, target.postId, telegramUserId);
    return postEditState(target, post, telegramUserId);
  }

  private async selfEditRights(userId: string, { accountId, chatKey }: PostTarget, expectedTelegramUserId: string) {
    const chat = this.deps.postChat({ userId, accountId }, chatKey);
    const { participant } = await this.deps.tg.invoke(accountId, new Api.channels.GetParticipant({
      channel: toInputChannel(chat), participant: new Api.InputPeerSelf(),
    }), { expectedTelegramUserId });
    this.deps.postChat({ userId, accountId }, chatKey);
    return {
      any: participant.className === 'ChannelParticipantCreator' || (participant.className === 'ChannelParticipantAdmin' && !!participant.adminRights.editMessages),
      own: participant.className === 'ChannelParticipantAdmin' && !!participant.adminRights.postMessages,
    };
  }

  async postEditCapability(userId: string, state: PostEditState, writesEnabled: boolean, content = false) {
    if (!writesEnabled || !this.deps.profileCanWrite(userId)) return { code: 'ACCESS_DENIED', reason: 'This profile is read-only.' } as const;
    const unsupported = content ? state.contentUnsupported : state.unsupported;
    if (unsupported) return { code: 'INVALID_ARGUMENT', reason: unsupported } as const;
    const rights = await this.selfEditRights(userId, state.target, state.telegramUserId);
    if (!this.deps.profileCanWrite(userId)) return { code: 'ACCESS_DENIED', reason: 'This profile is read-only.' } as const;
    return channelEditDenial(rights, state.post);
  }

  requirePostWriteAccess(userId: string, target: PostTarget) {
    if (!this.deps.profileCanWrite(userId)) throw new GatewayError('ACCESS_DENIED', 'This profile is read-only.');
    return this.deps.postChat({ userId, accountId: target.accountId }, target.chatKey);
  }

  /** Resolve outbound mentions only in the approved account. Read-back uses the public user ID. */
  contentEntities(userId: string, plan: ContentPlan, state: PostEditState): Api.TypeMessageEntity[] {
    return plan.spans.map(span => {
      const entity = entityOf(span);
      if (entity.className !== 'MessageEntityMentionName') return entity;
      const record = this.deps.mentionUser(plan.accountId, entity.userId.toString());
      const existing = state.post.entities?.some(e => e.className === 'MessageEntityMentionName' && e.userId.equals(entity.userId));
      if (!record?.accessHash && !existing) throw new GatewayError('INVALID_ARGUMENT', 'Resolve the mentioned user with this account before preparing the edit.');
      const inputUser = record?.accessHash ? toInputUser(record) : new Api.InputUserFromMessage({
        peer: toInputPeer(this.deps.postChat({ userId, accountId: plan.accountId }, plan.chatKey)), msgId: plan.postId, userId: entity.userId,
      });
      return new Api.InputMessageEntityMentionName({ offset: span.offset, length: span.length, userId: inputUser });
    });
  }

  private async premiumAccount(accountId: string, expectedTelegramUserId: string) {
    const [me] = await this.deps.tg.invoke(accountId, new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }), { expectedTelegramUserId });
    if (me?.className !== 'User' || me.id.toString() !== expectedTelegramUserId) throw new GatewayError('UNAVAILABLE', 'Cannot verify account entitlements.');
    return !!me.premium;
  }

  async contentLimits(accountId: string, expectedTelegramUserId: string, caption: boolean): Promise<ContentLimits> {
    const options = { expectedTelegramUserId };
    const config = await this.deps.tg.invoke(accountId, new Api.help.GetConfig(), options);
    const limits: ContentLimits = { length: config.messageLengthMax };
    if (caption) {
      limits.premium = await this.premiumAccount(accountId, expectedTelegramUserId);
      const key = limits.premium ? 'caption_length_limit_premium' : 'caption_length_limit_default';
      limits.app = await this.deps.tg.invoke(accountId, new Api.help.GetAppConfig({ hash: 0 }), options);
      limits.length = appInteger(limits.app, key, config.captionLengthMax);
    }
    if (!Number.isSafeInteger(limits.length) || limits.length <= 0) throw new GatewayError('UNAVAILABLE', 'Telegram returned no usable content limit.');
    return limits;
  }

  /** EditMessage resends the entire vector, including emoji that another administrator originally posted. */
  async checkOutgoingEntities(target: { accountId: string; telegramUserId: string }, value: string, spans: Span[], limits?: ContentLimits) {
    checkEntityRules(spans);
    const emoji = spans.filter(s => s.type === 'custom_emoji');
    if (!emoji.length) return;
    const { accountId, telegramUserId: expectedTelegramUserId } = target;
    const options = { expectedTelegramUserId };
    const app = limits?.app ?? await this.deps.tg.invoke(accountId, new Api.help.GetAppConfig({ hash: 0 }), options);
    // Telegram's documented default applies when the returned app configuration omits this key.
    const max = appInteger(app, 'message_animated_emoji_max', 100);
    if (emoji.length > max) throw new GatewayError('INVALID_ARGUMENT', 'The edit exceeds the account limit of ' + max + ' custom emoji occurrences.');
    const premium = limits?.premium ?? await this.premiumAccount(accountId, expectedTelegramUserId);
    const ids = [...new Set(emoji.map(s => s.document_id!))];
    const docs = await this.deps.tg.invoke(accountId, new Api.messages.GetCustomEmojiDocuments({ documentId: ids.map(id => bigInt(id)) }), options);
    const attributes = new Map(docs.flatMap(d => d.className === 'Document'
      ? [[d.id.toString(), d.attributes.find(a => a.className === 'DocumentAttributeCustomEmoji')] as const] : []));
    for (const span of emoji) {
      const attribute = attributes.get(span.document_id!);
      if (!attribute || attribute.alt !== value.slice(span.offset, span.offset + span.length) || (!attribute.free && !premium)) {
        throw new GatewayError('INVALID_ARGUMENT', 'Every outgoing custom emoji requires its Telegram fallback glyph and verified account eligibility.');
      }
    }
  }

  async verifyPostEdit(userId: string, plan: ApprovedPostPlan, matched: LinkOutcome, mismatch: LinkOutcome) {
    const data = { op: 'op' in plan ? plan.op : 'replace_link_url', message_id: plan.postId, chat: plan.chatKey };
    try {
      requireBoundPlan(plan, true);
      const current = await this.readPostEditState(userId, plan, plan.telegramUserId);
      // Telegram can reorder equal-position entities. Their complete TL fields and ranges define content.
      const diff = differences(plan.expected, observedFields(current, plan), 'op' in plan);
      const outcome = diff.length ? mismatch : matched;
      return { summary: `Observed post #${plan.postId}: ${outcome}`, data: { ...data, outcome, differences: diff } };
    } catch (err) {
      // Never expose post contents after access is revoked. The write may already be committed.
      return { summary: 'Unable to verify the approved post.', data: { ...data, outcome: 'outcome_unknown',
        read_error: isGatewayError(err) ? err.code : 'UNAVAILABLE',
        ...(isGatewayError(err) && err.retryAfter ? { retry_after: err.retryAfter } : {}) } };
    }
  }

  async executePostEdit(userId: string, plan: ApprovedPostPlan) {
    const { accountId, chatKey, postId } = plan;
    const context = { userId, accountId };
    const key = this.claimEdit(chatKey, postId);
    try {
      if (!this.deps.profileCanWrite(userId)) throw new GatewayError('ACCESS_DENIED', 'This profile is read-only.');
      requireBoundPlan(plan);
      const rights = await this.selfEditRights(userId, plan, plan.telegramUserId);
      if ('op' in plan) {
        const limits = await this.contentLimits(accountId, plan.telegramUserId, !!plan.expected.attachment);
        assertContentLength([...plan.value].length, limits.length);
        await this.checkOutgoingEntities(plan, plan.value, plan.spans, limits);
      }
      const readApproved = async () => {
        const current = await this.readPostEditState(userId, plan, plan.telegramUserId);
        if (current.revision !== plan.revision || (!('op' in plan) && !current.links.some(l => l.index === plan.index && l.url === plan.oldUrl))) {
          throw new GatewayError('EDIT_CONFLICT', 'The post changed since the preview. Prepare a fresh edit.');
        }
        return current;
      };
      let state = await readApproved();
      if (!('op' in plan)) {
        const spans = (state.post.entities ?? []).map(describeEntity);
        await this.checkOutgoingEntities(plan, state.post.message, spans);
        if (spans.some(s => s.type === 'custom_emoji')) state = await readApproved();
      }
      const denial = channelEditDenial(rights, state.post);
      if (denial) throw new GatewayError(denial.code, denial.reason);
      const checkAccess = () => this.requirePostWriteAccess(userId, plan);
      const chat = checkAccess();
      const content = 'op' in plan;
      const message = content ? plan.value : state.post.message;
      const entities = content ? this.contentEntities(userId, plan, state) : changedEntities(state.post, plan.index, plan.newUrl);
      if (differences(plan.expected, observedFields(state, plan), content).length === 0) return await this.verifyPostEdit(userId, plan, 'no-op', 'conflict');
      let matched: LinkOutcome = 'verified';
      let mismatch: LinkOutcome = 'conflict';
      try {
        await this.deps.tg.invoke(accountId, new Api.messages.EditMessage({
          peer: toInputPeer(chat), id: postId, message, entities, noWebpage: isCaption(state.post) ? undefined : true,
          invertMedia: state.post.invertMedia || undefined,
        }), { write: true, singleAttempt: true, beforeInvoke: checkAccess, expectedTelegramUserId: plan.telegramUserId });
      } catch (err) {
        if (isGatewayError(err) && err.telegramCode === 'MESSAGE_NOT_MODIFIED') matched = 'no-op';
        else if (isGatewayError(err) && err.outcomeUnknown) mismatch = 'outcome_unknown';
        else throw err;
      }
      const result = await this.verifyPostEdit(userId, plan, matched, mismatch);
      if (result.data.outcome === 'verified') this.record({ ts: this.now(), ...context, kind: 'edit', chatKey, postId, sentMessageId: null });
      return result;
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
