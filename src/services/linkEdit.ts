import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { sha256Hex } from '../core/crypto.js';
import { peerKeyOfPeer } from '../core/entities.js';
import { GatewayError } from '../core/errors.js';

/** This operation targets an existing TextUrl and preserves the server's other entities. */
export const LINK_EDIT = 'replace_link_url';
export type PublishedPost = Api.Message & { invertMedia?: boolean; suggestedPost?: unknown; scheduleRepeatPeriod?: number; factcheck?: Api.FactCheck };
export interface PostTarget { accountId: string; chatKey: string; postId: number }
export type LinkOutcome = 'verified' | 'no-op' | 'conflict' | 'failed' | 'outcome_unknown';

function digest(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function isCaption(post: PublishedPost): boolean {
  return post.media?.className === 'MessageMediaPhoto' || post.media?.className === 'MessageMediaDocument';
}

/** Ignore renewable download credentials when comparing an untouched attachment. */
function photoIdentity(photo: Api.TypePhoto | undefined) {
  return photo?.className === 'Photo' ? new Api.Photo({ ...photo, accessHash: bigInt.zero, fileReference: Buffer.alloc(0) }) : photo;
}

function documentIdentity(doc: Api.TypeDocument | undefined) {
  return doc?.className === 'Document' ? new Api.Document({ ...doc, accessHash: bigInt.zero, fileReference: Buffer.alloc(0) }) : doc;
}

function attachment(post: PublishedPost): string | undefined {
  const m = post.media;
  if (m?.className === 'MessageMediaPhoto' && m.photo?.className === 'Photo' && typeof m.getBytes === 'function') {
    return digest(new Api.MessageMediaPhoto({ ...m, photo: photoIdentity(m.photo), video: documentIdentity(m.video) }).getBytes().toString('hex'));
  }
  if (m?.className === 'MessageMediaDocument' && m.document?.className === 'Document' && typeof m.getBytes === 'function') {
    return digest(new Api.MessageMediaDocument({ ...m, document: documentIdentity(m.document), videoCover: photoIdentity(m.videoCover),
      altDocuments: m.altDocuments?.map(d => documentIdentity(d)!) }).getBytes().toString('hex'));
  }
  return undefined;
}

export function entityFingerprints(entities: Api.TypeMessageEntity[]) {
  return entities.map(entity => digest(entity.getBytes().toString('hex')));
}

export function semanticFields(post: PublishedPost, entities = post.entities ?? [], value = post.message) {
  const mediaIdentity = attachment(post);
  return {
    text: digest(value),
    entities: entityFingerprints(entities),
    media: post.media?.className ?? 'MessageMediaEmpty',
    ...(mediaIdentity ? { attachment: mediaIdentity } : {}),
    album: post.groupedId?.toString() ?? null,
    invert_media: !!post.invertMedia,
    markup: post.replyMarkup?.className ?? null,
    rich: !!post.richMessage,
    factcheck: post.factcheck?.hash.toString() ?? null,
    pinned: !!post.pinned,
    author: digest([peerKeyOfPeer(post.fromId), post.postAuthor ?? null, post.date, post.fwdFrom?.getBytes().toString('hex')]),
    restrictions: digest([!!post.noforwards, post.ttlPeriod ?? null, post.restrictionReason?.map(r => r.getBytes().toString('hex'))]),
    discussion: post.replies?.channelId?.toString() ?? null,
    comments: !!post.replies?.comments,
    reply_to: post.replyTo ? digest(post.replyTo.getBytes().toString('hex')) : null,
    via_bot: post.viaBotId?.toString() ?? null,
    suggested: !!post.suggestedPost,
    repeat: post.scheduleRepeatPeriod ?? null,
  };
}
type Fields = ReturnType<typeof semanticFields>;

export interface LinkPlan extends PostTarget {
  version: 2;
  telegramUserId: string;
  revision: string;
  index: number;
  oldUrl: string;
  newUrl: string;
  expected: Fields;
}

const supportedEntities = new Set([
  'Mention', 'Hashtag', 'BotCommand', 'Url', 'Email', 'Bold', 'Italic', 'Code', 'Pre', 'TextUrl',
  'Phone', 'Cashtag', 'Underline', 'Strike', 'BankCard', 'Spoiler', 'CustomEmoji', 'Blockquote', 'FormattedDate',
].map(name => 'MessageEntity' + name));

function unsupported(post: PublishedPost, content: boolean, attachmentId?: string): string | undefined {
  if (post.factcheck) return 'Editing a post with a fact check is not supported.';
  if (post.replyMarkup) return 'Keeping the inline keyboard is not supported for link edits yet.';
  if (post.replyTo?.replyMedia) return 'A reply containing attached media is not supported for link edits.';
  if (post.richMessage || post.viaBotId || post.suggestedPost || post.scheduleRepeatPeriod) return 'This special post type is not supported for link edits.';
  if (content && post.media?.className === 'MessageMediaDocument' && post.media.document?.className === 'Document' &&
    (post.media.round || post.media.document.attributes.some(a => a.className === 'DocumentAttributeSticker' ||
      a.className === 'DocumentAttributeCustomEmoji' || (a.className === 'DocumentAttributeVideo' && a.roundMessage)))) {
    return 'Stickers and round video messages do not support this caption operation.';
  }
  if (post.groupedId || (post.media && post.media.className !== 'MessageMediaEmpty' && !(content && attachmentId))) {
    return content ? 'Choose a standalone text post or photo/document caption without a web card or album.'
      : 'This operation supports published text posts without media, albums or web preview cards.';
  }
  for (const e of post.entities ?? []) {
    if (!supportedEntities.has(e.className) && !(content && e.className === 'MessageEntityMentionName')) return 'This operation cannot safely resubmit ' + e.className + '.';
    if (e.offset < 0 || e.length <= 0 || e.offset + e.length > post.message.length) return 'The existing entity range is invalid.';
  }
  return undefined;
}

export function postEditState(target: PostTarget, post: PublishedPost, telegramUserId: string) {
  const fields = semanticFields(post);
  const revision = digest([2, target.accountId, telegramUserId, target.chatKey, target.postId, post.editDate ?? null, fields]);
  const links = (post.entities ?? []).flatMap((e, index) => {
    if (e.className !== 'MessageEntityTextUrl') return [];
    const end = e.offset + e.length;
    return [{
      selector: revision.slice(0, 24) + '.' + index, index, url: e.url,
      label: post.message.slice(e.offset, end),
      context: { before: post.message.slice(Math.max(0, e.offset - 28), e.offset), after: post.message.slice(end, end + 28) },
    }];
  });
  return { target, telegramUserId, post, fields, revision, links, unsupported: unsupported(post, false),
    contentUnsupported: unsupported(post, true, fields.attachment) };
}
export type PostEditState = ReturnType<typeof postEditState>;

export function validateUrl(url: string): void {
  // In Unicode mode Cs matches only unpaired surrogates. TL strings use UTF-8.
  if (/\p{Cs}/u.test(url)) throw new GatewayError('INVALID_ARGUMENT', 'new_url contains an unpaired UTF-16 surrogate.');
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (!parsed || !['http:', 'https:', 'tg:'].includes(parsed.protocol) || !/^(?:https?|tg):\/\//i.test(url)
      || /[\s\p{Cc}\p{Cf}\\]/u.test(url) || !parsed.hostname) {
    throw new GatewayError('INVALID_ARGUMENT', 'new_url must be an absolute HTTP, HTTPS or tg URL without whitespace, control characters or backslashes.');
  }
}

export function changedEntities(post: PublishedPost, index: number, url: string) {
  return (post.entities ?? []).map((entity, i) => i === index
    ? new Api.MessageEntityTextUrl({ offset: entity.offset, length: entity.length, url })
    : entity);
}

export function makeLinkPlan(state: PostEditState, index: number, oldUrl: string, newUrl: string): LinkPlan {
  return { ...state.target, version: 2, telegramUserId: state.telegramUserId, revision: state.revision, index, oldUrl, newUrl,
    expected: semanticFields(state.post, changedEntities(state.post, index, newUrl)) };
}

/** Earlier PR builds issued v1 approvals with only a local account alias. */
export function requireBoundLinkPlan(plan: LinkPlan): void {
  if (plan.version !== 2 || !plan.telegramUserId) {
    throw new GatewayError('EDIT_CONFLICT', 'This link approval has no verified Telegram identity. Prepare a fresh preview.');
  }
}

export function differences(expected: Fields, actual: Fields, ignoreEntityOrder = false): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(expected) as (keyof Fields)[]) {
    if (key === 'entities') {
      if (ignoreEntityOrder && expected.entities.length === actual.entities.length) {
        const observed = [...actual.entities].sort();
        if ([...expected.entities].sort().every((hash, i) => hash === observed[i])) continue;
      }
      const length = Math.max(expected.entities.length, actual.entities.length);
      for (let i = 0; i < length; i++) if (expected.entities[i] !== actual.entities[i]) changed.push('entities[' + i + ']');
    } else if (expected[key] !== actual[key]) changed.push(key);
  }
  return changed;
}
