import { Api } from 'teleproto';
import { GatewayError } from '../core/errors.js';
import type { PublishedPost } from './linkEdit.js';

export const cardSizes = ['auto', 'small', 'large'] as const;
export const cardPositions = ['top', 'bottom'] as const;
export type Size = typeof cardSizes[number];
export type Position = typeof cardPositions[number];

export interface CardSettings { url: string; manual: boolean; size: Size; position: Position }
export type CardInfo =
  | { kind: 'off' }
  | { kind: 'unavailable'; reason: string; pending: boolean }
  | { kind: 'ready'; settings: CardSettings; resizable: boolean };

export function httpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) && !/[\s\p{Cc}\p{Cf}\p{Cs}\\]/u.test(s) && URL.canParse(s) && !!new URL(s).hostname;
}

export function readCard(media: Api.TypeMessageMedia | undefined, onTop = false): CardInfo {
  if (!media || media.className === 'MessageMediaEmpty') return { kind: 'off' };
  if (media.className !== 'MessageMediaWebPage') return { kind: 'unavailable', pending: false, reason: 'Link cards require a standalone text post.' };
  const page = media.webpage;
  if (!page || page.className !== 'WebPage') {
    const pending = page?.className === 'WebPagePending';
    return { kind: 'unavailable', pending, reason: pending ? 'Telegram is still resolving the web preview.' : 'Telegram did not supply a resolved web preview.' };
  }
  if (typeof page.url !== 'string' || !httpUrl(page.url) || (media.forceSmallMedia && media.forceLargeMedia)) {
    return { kind: 'unavailable', pending: false, reason: 'The current URL or size flags cannot be represented safely.' };
  }
  return { kind: 'ready', resizable: page.hasLargeMedia === true, settings: {
    url: page.url, manual: !!media.manual, size: media.forceSmallMedia ? 'small' : media.forceLargeMedia ? 'large' : 'auto',
    position: onTop ? 'top' : 'bottom',
  } };
}

export function cardFields(card: CardInfo) {
  if (card.kind === 'off') return {};
  if (card.kind === 'unavailable') return { preview_state: card.pending ? 'pending' : 'unresolved' };
  return { preview_state: 'ready', preview_url: card.settings.url, preview_manual: card.settings.manual, preview_size: card.settings.size };
}

export function cardUrls(post: PublishedPost): string[] {
  const urls = new Set<string>();
  for (const e of [...(post.entities ?? [])].sort((a,b) => a.offset-b.offset)) {
    let url = e.className === 'MessageEntityTextUrl' ? e.url : e.className === 'MessageEntityUrl' ? post.message.slice(e.offset,e.offset+e.length) : '';
    if (e.className === 'MessageEntityUrl' && url && !/^[a-z][a-z\d+.-]*:/i.test(url)) url = 'https://' + url;
    if (httpUrl(url)) urls.add(url);
  }
  return [...urls];
}

/** Only a single known target is locally predictable. Other changes ask Telegram for its selection. */
export function stableAutomaticInput(post: PublishedPost, url: string, value: string, entities: Api.TypeMessageEntity[]): boolean {
  const candidates = cardUrls(post);
  if (candidates.length !== 1 || new URL(candidates[0]).href !== new URL(url).href) return false;
  const ignored = new Set(['MessageEntityBold','MessageEntityItalic','MessageEntityStrike','MessageEntityUnderline','MessageEntitySpoiler']);
  const relevant = (list: Api.TypeMessageEntity[]) => list.filter(e => !ignored.has(e.className));
  const original = relevant(post.entities ?? []);
  const updated = relevant(entities);
  if (original.length !== updated.length) return false;
  const before = post.message;
  if (before === value) return original.every((e,i) => e.getBytes().equals(updated[i].getBytes()));

  // Compare at whole token boundaries, so a changed suffix cannot silently extend a URL.
  // Mask ordinary prose only. Punctuation, numbers, URL candidates and formatted ranges are significant.
  const tokens = (text: string, spans: Api.TypeMessageEntity[]) => {
    if (spans.some(e => e.className !== 'MessageEntityUrl' && e.className !== 'MessageEntityTextUrl')) return null;
    const signatures: unknown[] = [];
    for (const m of text.matchAll(/[^ \t\r\n]+|[ \t\r\n]+/gu)) {
      const start = m.index!, end = start + m[0].length;
      const inside = spans.filter(e => e.offset < end && e.offset + e.length > start);
      if (inside.some(e => e.offset < start || e.offset + e.length > end)) return null;
      signatures.push(!inside.length && /^\p{L}+$/u.test(m[0]) ? null : [m[0],
        inside.map(e => [e.className,e.offset-start,e.length,e.className === 'MessageEntityTextUrl' ? e.url : null])]);
    }
    return JSON.stringify(signatures);
  };
  const oldTokens = tokens(before,original);
  return oldTokens !== null && oldTokens === tokens(value,updated);
}

function refuse(reason: string): never { throw new GatewayError('INVALID_ARGUMENT', reason); }

export function checkSize(info: CardInfo, size: Size) {
  if (info.kind !== 'ready') refuse(info.kind === 'unavailable' ? info.reason : 'Telegram could not generate a web preview for this URL.');
  if (size !== 'auto' && !info.resizable) refuse('Telegram does not allow changing the media size of this web preview.');
  return info.settings.url;
}

export function cardMedia(url: string, size: Size) {
  return new Api.InputMediaWebPage({ url, forceSmallMedia: size === 'small' || undefined, forceLargeMedia: size === 'large' || undefined });
}
