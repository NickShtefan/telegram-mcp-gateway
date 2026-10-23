/**
 * Parses and constructs Telegram links. Agents may reference chats or messages
 * by `@username`, marked ID, t.me link, private link,
 * `t.me/c/...`, invite, or `tg://...` deep link. Normalize these forms
 * into one structure using pure functions, without network calls or ID resolution.
 */
import { isBotApiChannelId, looksLikePeerKey, parsePeerKey, peerKey, toBotApiChatId, toMtprotoChannelId } from '../core/chatId.js';
import { GatewayError } from '../core/errors.js';

export type ChatTarget =
  /** Username without @, preserving input case. */
  | { type: 'username'; username: string }
  /** Marked ID as a string; see `src/core/chatId.ts`. */
  | { type: 'peer'; peerKey: string }
  /** Private invite hash. */
  | { type: 'invite'; hash: string };

export interface ParsedRef {
  chat: ChatTarget;
  /** Post or message ID. */
  messageId?: number;
  /** Forum topic ID (`t.me/name/TOPIC/MSG`, `t.me/c/ID/TOPIC/MSG`, or `?thread=N`). */
  topicId?: number;
  /** `?comment=N`: a comment on a channel post. */
  commentId?: number;
}

const HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

/** First t.me path segments that are not usernames. */
const RESERVED_SEGMENTS = new Set([
  'joinchat',
  'addstickers',
  'addemoji',
  'addlist',
  'share',
  'proxy',
  'socks',
  'login',
  'iv',
  'boost',
  'setlanguage',
  'addtheme',
  'bg',
  'invoice',
  'giftcode',
  'm',
  'c',
  's',
]);

/** 4-32 characters, beginning with a letter and not ending with an underscore. */
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,30}[A-Za-z0-9]$/;
const INVITE_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CHANNEL_ID_RE = /^\d{1,18}$/;
const ID_RE = /^\d{1,10}$/;
/** MTProto message and topic IDs are int32. */
const MAX_ID = 2_147_483_647;
const MAX_ECHO = 80;

const ACCEPTED_FORMS =
  'Accepted forms: @username or username; a numeric chat id (user 123, basic group -123, channel or supergroup -100...); ' +
  'https://t.me/username, https://t.me/username/MESSAGE_ID, https://t.me/username/TOPIC_ID/MESSAGE_ID; ' +
  'https://t.me/c/CHANNEL_ID/MESSAGE_ID, https://t.me/c/CHANNEL_ID/TOPIC_ID/MESSAGE_ID; ' +
  'optional ?thread=TOPIC_ID and ?comment=COMMENT_ID; invite links https://t.me/+HASH and https://t.me/joinchat/HASH; ' +
  'deep links tg://resolve?domain=username&post=ID, tg://privatepost?channel=CHANNEL_ID&post=ID, tg://join?invite=HASH.';

const USERNAME_RULES = '4 to 32 characters, only letters, digits and underscore, starts with a letter, does not end with an underscore';

/** Quotes, escapes, and truncates untrusted input for error messages. */
function quote(value: string): string {
  return JSON.stringify(value.length > MAX_ECHO ? `${value.slice(0, MAX_ECHO)}...` : value);
}

function fail(input: string, reason: string): never {
  throw new GatewayError('INVALID_ARGUMENT', `Invalid chat or message reference ${quote(input)}: ${reason}. ${ACCEPTED_FORMS}`);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Query parameters such as `a=1&b&c=3`; duplicate keys use the first value. */
function parseQuery(query: string | undefined): Map<string, string> {
  const params = new Map<string, string>();
  if (!query) return params;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = safeDecode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : safeDecode(part.slice(eq + 1));
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function positiveInt(value: string, what: string, input: string): number {
  if (!ID_RE.test(value)) return fail(input, `${what} must be a positive integer, got ${quote(value)}`);
  const n = Number(value);
  if (n < 1 || n > MAX_ID) return fail(input, `${what} must be between 1 and ${MAX_ID}, got ${quote(value)}`);
  return n;
}

function usernameTarget(value: string, input: string): ChatTarget {
  if (!isValidUsername(value)) {
    return fail(input, `${quote(value)} is not a valid Telegram username (${USERNAME_RULES})`);
  }
  return { type: 'username', username: value };
}

function inviteTarget(hash: string | undefined, input: string): ChatTarget {
  if (hash === undefined || hash === '') return fail(input, 'the invite link has no hash');
  if (!INVITE_HASH_RE.test(hash)) return fail(input, `${quote(hash)} is not a valid invite hash`);
  return { type: 'invite', hash };
}

/** Converts bare channel IDs from t.me/c/ID or tg://privatepost?channel=ID to marked IDs. */
function channelTarget(value: string | undefined, input: string): ChatTarget {
  if (value === undefined || !CHANNEL_ID_RE.test(value) || BigInt(value) === 0n) {
    return fail(
      input,
      `expected a positive bare channel id (without the -100 prefix) in a private link, got ${quote(value ?? '')}`,
    );
  }
  return { type: 'peer', peerKey: toBotApiChatId(value) };
}

interface RefIds {
  messageId?: number;
  topicId?: number;
  commentId?: number;
}

/** Numeric segments after a chat: `MSG` or `TOPIC/MSG`. */
function pathIds(rest: string[], input: string): RefIds {
  if (rest.length === 0) return {};
  if (rest.length === 1) return { messageId: positiveInt(rest[0]!, 'message id', input) };
  if (rest.length === 2) {
    return { topicId: positiveInt(rest[0]!, 'topic id', input), messageId: positiveInt(rest[1]!, 'message id', input) };
  }
  return fail(input, 'too many path segments after the chat (expected MESSAGE_ID or TOPIC_ID/MESSAGE_ID)');
}

/** `?thread=` and `?comment=`; path topics take precedence over query topics. */
function withQueryIds(ids: RefIds, params: Map<string, string>, input: string): RefIds {
  const out: RefIds = { ...ids };
  const thread = params.get('thread');
  if (thread !== undefined) {
    const topicId = positiveInt(thread, 'thread (topic id)', input);
    if (out.topicId === undefined) out.topicId = topicId;
  }
  const comment = params.get('comment');
  if (comment !== undefined) {
    out.commentId = positiveInt(comment, 'comment id', input);
    if (out.messageId === undefined) return fail(input, 'comment id is given without a post id');
  }
  return out;
}

/** Builds results without undefined keys. */
function buildRef(chat: ChatTarget, ids: RefIds): ParsedRef {
  const ref: ParsedRef = { chat };
  if (ids.messageId !== undefined) ref.messageId = ids.messageId;
  if (ids.topicId !== undefined) ref.topicId = ids.topicId;
  if (ids.commentId !== undefined) ref.commentId = ids.commentId;
  return ref;
}

/** Deep links: tg://resolve, tg://privatepost, tg://join, including forms without //. */
function parseTgLink(raw: string, input: string): ParsedRef {
  const m = /^tg:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(raw);
  const action = (m?.[1] ?? '').replace(/\/+$/, '').toLowerCase();
  const params = parseQuery(m?.[2]);

  if (action === 'join') {
    return buildRef(inviteTarget(params.get('invite'), input), {});
  }

  if (action === 'resolve' || action === 'privatepost') {
    let chat: ChatTarget;
    if (action === 'resolve') {
      const domain = params.get('domain');
      if (domain === undefined || domain === '') {
        return fail(input, 'tg://resolve needs the domain parameter (links by phone number are not supported)');
      }
      chat = usernameTarget(domain, input);
    } else {
      chat = channelTarget(params.get('channel'), input);
    }
    const post = params.get('post');
    const ids: RefIds = post === undefined ? {} : { messageId: positiveInt(post, 'post (message id)', input) };
    return buildRef(chat, withQueryIds(ids, params, input));
  }

  return fail(input, `unsupported tg:// link ${quote(action)} (supported: resolve, privatepost, join)`);
}

/** t.me, telegram.me, and telegram.dog links, with or without a scheme. */
function parseHttpLink(raw: string, input: string): ParsedRef {
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(raw);
  const scheme = m?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return fail(input, `unsupported link scheme ${quote(scheme)}`);
  }

  const authority = (m?.[2] ?? '').toLowerCase();
  const host = authority.replace(/^www\./, '').replace(/:\d+$/, '');
  if (!HOSTS.has(host)) {
    if (scheme === undefined && /^[A-Za-z0-9_]+$/.test(raw)) {
      return fail(input, `not a valid Telegram username (${USERNAME_RULES})`);
    }
    if (scheme !== undefined || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(authority)) {
      return fail(input, `${quote(authority)} is not a Telegram host (expected t.me, telegram.me or telegram.dog)`);
    }
    return fail(input, 'it is not a username, a numeric chat id or a Telegram link');
  }

  // Discard empty segments to handle trailing and doubled slashes.
  const segments = (m?.[3] ?? '').split('/').filter(s => s !== '').map(safeDecode);
  const params = parseQuery(m?.[4]);
  if (segments.length === 0) return fail(input, 'the link has no chat in its path');

  let first = segments[0]!;
  let rest = segments.slice(1);

  // Invite: t.me/+HASH. The digits-only form refers to a phone number.
  if (first.startsWith('+')) {
    const hash = first.slice(1);
    if (/^\d+$/.test(hash)) return fail(input, 'links by phone number (t.me/+PHONE) are not supported');
    if (rest.length > 0) return fail(input, 'unexpected path segments after the invite hash');
    return buildRef(inviteTarget(hash, input), {});
  }

  const lower = first.toLowerCase();

  if (lower === 'joinchat') {
    if (rest.length > 1) return fail(input, 'unexpected path segments after the invite hash');
    return buildRef(inviteTarget(rest[0], input), {});
  }

  if (lower === 'c') {
    const chat = channelTarget(rest[0], input);
    return buildRef(chat, withQueryIds(pathIds(rest.slice(1), input), params, input));
  }

  // Web previews t.me/s/username[/MSG] are equivalent to links without /s/.
  if (lower === 's') {
    if (rest.length === 0) return fail(input, 'the web preview link t.me/s/ has no username');
    first = rest[0]!;
    rest = rest.slice(1);
  }

  if (RESERVED_SEGMENTS.has(first.toLowerCase())) {
    return fail(input, `t.me/${first.toLowerCase()} is a special Telegram link, not a chat or message reference`);
  }

  const chat = usernameTarget(first, input);
  return buildRef(chat, withQueryIds(pathIds(rest, input), params, input));
}

/** true if the string is a syntactically valid Telegram username (without @). */
export function isValidUsername(value: string): boolean {
  return typeof value === 'string' && USERNAME_RE.test(value);
}

/** Parses anything an agent may pass as a chat or message reference. Throws GatewayError('INVALID_ARGUMENT'). */
export function parseRef(input: string): ParsedRef {
  if (typeof input !== 'string') {
    throw new GatewayError('INVALID_ARGUMENT', `Invalid chat or message reference: expected a string, got ${typeof input}. ${ACCEPTED_FORMS}`);
  }
  const raw = input.trim();
  if (raw === '') return fail(input, 'the reference is empty');

  if (/^tg:/i.test(raw)) return parseTgLink(raw, input);

  if (looksLikePeerKey(raw)) {
    if (BigInt(raw) === 0n) return fail(input, 'a chat id must not be zero');
    // parsePeerKey and peerKey produce canonical IDs without leading zeros.
    return { chat: { type: 'peer', peerKey: peerKey(parsePeerKey(raw)) } };
  }

  if (raw.startsWith('@')) return { chat: usernameTarget(raw.slice(1), input) };
  if (isValidUsername(raw)) return { chat: { type: 'username', username: raw } };

  return parseHttpLink(raw, input);
}

function isPositiveId(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID;
}

/**
 * Builds a t.me link to a message, or null when no link form exists (users, basic groups).
 *
 * Message links exist only for channels and supergroups. Other peer keys
 * return null even when a username is supplied. Invalid message IDs
 * also return null: formatting tools must not fail
 * because a link cannot be constructed.
 */
export function messageLink(target: {
  username?: string | null;
  peerKey: string;
  messageId: number;
  topicId?: number;
  commentId?: number;
}): string | null {
  if (!isPositiveId(target.messageId)) return null;
  if (!isBotApiChannelId(target.peerKey)) return null;

  const username = typeof target.username === 'string' ? target.username.trim().replace(/^@/, '') : '';
  const base = isValidUsername(username)
    ? `https://t.me/${username}`
    : `https://t.me/c/${toMtprotoChannelId(target.peerKey).toString()}`;
  const topic = isPositiveId(target.topicId) ? `/${target.topicId}` : '';
  const comment = isPositiveId(target.commentId) ? `?comment=${target.commentId}` : '';
  return `${base}${topic}/${target.messageId}${comment}`;
}
