import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { sha256Hex } from '../core/crypto.js';
import { peerKeyOfPeer } from '../core/entities.js';
import { GatewayError } from '../core/errors.js';
import { cardFields, cardUrlKey, readCard, sameCardUrl, type CardInfo } from './webPreview.js';

/** This operation targets an existing TextUrl and preserves the server's other entities. */
export const LINK_EDIT = 'replace_link_url';
export type PublishedPost = Api.Message & { invertMedia?: boolean; suggestedPost?: unknown; scheduleRepeatPeriod?: number; factcheck?: Api.FactCheck };
export interface PostTarget { accountId: string; chatKey: string; postId: number }

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
    ...(post.media?.className === 'MessageMediaWebPage' ? cardFields(readCard(post.media,post.invertMedia)) : {}),
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

function unsupported(post: PublishedPost, content: boolean, card: CardInfo, attachmentId?: string): string | undefined {
  if (post.factcheck) return 'Editing a post with a fact check is not supported.';
  if (post.replyMarkup) return 'Keeping the inline keyboard is not supported for link edits yet.';
  if (post.replyTo?.replyMedia) return 'A reply containing attached media is not supported for link edits.';
  if (post.richMessage || post.viaBotId || post.suggestedPost || post.scheduleRepeatPeriod) return 'This special post type is not supported for link edits.';
  if (content && post.media?.className === 'MessageMediaDocument' && post.media.document?.className === 'Document' &&
    (post.media.round || post.media.document.attributes.some(a => a.className === 'DocumentAttributeSticker' ||
      a.className === 'DocumentAttributeCustomEmoji' || (a.className === 'DocumentAttributeVideo' && a.roundMessage)))) {
    return 'Stickers and round video messages do not support this caption operation.';
  }
  if (post.media?.className === 'MessageMediaWebPage' && card.kind === 'unavailable') return card.reason;
  if (post.groupedId || (post.media && post.media.className !== 'MessageMediaEmpty' && card.kind !== 'ready' && !(content && attachmentId))) {
    return content ? 'Choose a standalone text post or photo/document caption without an album.'
      : 'This operation requires a standalone broadcast text post.';
  }
  for (const e of post.entities ?? []) {
    if (!supportedEntities.has(e.className) && !(content && e.className === 'MessageEntityMentionName')) return 'This operation cannot safely resubmit ' + e.className + '.';
    if (e.offset < 0 || e.length <= 0 || e.offset + e.length > post.message.length) return 'The existing entity range is invalid.';
  }
  return undefined;
}

function postRevision(target: PostTarget, user: string, post: PublishedPost, fields: Fields) {
  return digest([2, target.accountId, user, target.chatKey, target.postId, post.editDate ?? null, fields]);
}

export function postEditState(target: PostTarget, post: PublishedPost, telegramUserId: string) {
  const fields = semanticFields(post);
  const card = readCard(post.media,post.invertMedia);
  const key = fields.preview_url && cardUrlKey(fields.preview_url);
  const revision = postRevision(target, telegramUserId, post, key ? { ...fields, preview_url: key } : fields);
  const links = (post.entities ?? []).flatMap((e, index) => {
    if (e.className !== 'MessageEntityTextUrl') return [];
    const end = e.offset + e.length;
    return [{
      selector: revision.slice(0, 24) + '.' + index, index, url: e.url,
      label: post.message.slice(e.offset, end),
      context: { before: post.message.slice(Math.max(0, e.offset - 28), e.offset), after: post.message.slice(end, end + 28) },
    }];
  });
  return { target, telegramUserId, post, fields, revision, links, card, unsupported: unsupported(post, false, card),
    contentUnsupported: unsupported(post, true, card, fields.attachment) };
}
export type PostEditState = ReturnType<typeof postEditState>;

/** Earlier approvals hashed the displayed spelling of the page URL. All other fields must still match. */
export function matchesPostRevision(state: PostEditState, revision: string, approvedUrl?: string): boolean {
  if (revision === state.revision) return true;
  const raw = state.fields.preview_url;
  if (!raw) return false;
  const legacy = (url: string) => postRevision(state.target, state.telegramUserId, state.post, { ...state.fields, preview_url: url });
  return legacy(raw) === revision || (!!approvedUrl && sameCardUrl(raw, approvedUrl) && legacy(approvedUrl) === revision);
}

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
    } else if (expected[key] !== actual[key]) {
      if (key === 'preview_url' && expected.preview_url && actual.preview_url && sameCardUrl(expected.preview_url, actual.preview_url)) continue;
      changed.push(key);
    }
  }
  return changed;
}
