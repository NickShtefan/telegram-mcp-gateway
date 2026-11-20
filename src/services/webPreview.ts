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
  | { kind: 'unavailable'; reason: string; pending: boolean; empty?: boolean;
      observed?: { preview_manual: boolean; preview_size: Size | 'invalid'; preview_url?: string } }
  | { kind: 'ready'; settings: CardSettings; resizable: boolean };

/** Normalize the authority and empty root path only. Keep path, query and fragment verbatim. */
export function cardUrlKey(value: string): string | undefined {
  const parts = /^(https?):\/\/([^/?#]+)([^?#]*)(.*)$/i.exec(value);
  if (!parts || /[\s\p{Cc}\p{Cf}\p{Cs}\\]/u.test(value) || /@|:$/.test(parts[2]) || !URL.canParse(value)) return;
  const url = new URL(value);
  return url.origin + (parts[3] || '/') + parts[4];
}

export function httpUrl(s: string): boolean {
  return cardUrlKey(s) !== undefined;
}

export function sameCardUrl(left: string, right: string): boolean {
  const key = cardUrlKey(left);
  return key !== undefined && key === cardUrlKey(right);
}

export function readCard(media: Api.TypeMessageMedia | undefined, onTop = false): CardInfo {
  if (!media || media.className === 'MessageMediaEmpty') return { kind: 'off' };
  if (media.className !== 'MessageMediaWebPage') return { kind: 'unavailable', pending: false, reason: 'Link cards require a standalone text post.' };
  const page = media.webpage;
  const size = media.forceSmallMedia && media.forceLargeMedia ? 'invalid' : media.forceSmallMedia ? 'small' : media.forceLargeMedia ? 'large' : 'auto';
  const observed = { preview_manual: !!media.manual, preview_size: size,
    ...(page?.className === 'WebPage' ? { preview_url: page.url } : {}) } as const;
  if (!page || page.className !== 'WebPage') {
    const pending = page?.className === 'WebPagePending';
    const empty = page?.className === 'WebPageEmpty';
    return { kind: 'unavailable', pending, empty, observed, reason: pending ? 'Telegram is still resolving the web preview.'
      : empty ? 'Telegram has no preview for this webpage.' : 'Telegram did not supply a resolved web preview.' };
  }
  if (typeof page.url !== 'string' || !httpUrl(page.url) || (media.forceSmallMedia && media.forceLargeMedia)) {
    return { kind: 'unavailable', pending: false, observed, reason: 'The current URL or size flags cannot be represented safely.' };
  }
  return { kind: 'ready', resizable: page.hasLargeMedia === true, settings: {
    url: page.url, manual: !!media.manual, size: media.forceSmallMedia ? 'small' : media.forceLargeMedia ? 'large' : 'auto',
    position: onTop ? 'top' : 'bottom',
  } };
}

export function cardFields(card: CardInfo): { preview_state?: 'pending' | 'empty' | 'unresolved' | 'ready';
  preview_url?: string; preview_manual?: boolean; preview_size?: Size | 'invalid' } {
  if (card.kind === 'off') return {};
  if (card.kind === 'unavailable') return { preview_state: card.pending ? 'pending' : card.empty ? 'empty' : 'unresolved', ...card.observed };
  return { preview_state: 'ready', preview_url: card.settings.url, preview_manual: card.settings.manual, preview_size: card.settings.size };
}

export function cardUrls(post: Pick<PublishedPost, 'message' | 'entities'>): string[] {
  const urls = new Map<string, string>();
  for (const e of [...(post.entities ?? [])].sort((a,b) => a.offset-b.offset)) {
    let url = e.className === 'MessageEntityTextUrl' ? e.url : e.className === 'MessageEntityUrl' ? post.message.slice(e.offset,e.offset+e.length) : '';
    if (e.className === 'MessageEntityUrl' && !/^https?:\/\//i.test(url)) {
      const authority = url.split(/[/?#]/, 1)[0];
      // A visible Telegram URL can omit its scheme, including a domain or IP with a port.
      if (authority.includes(':') && !/^(?:[^:@\s]+\.[^:@\s]+|localhost|\[[\da-f:.]+\])(?::\d+)?$/iu.test(authority)) continue;
      url = 'https://' + url;
    }
    const key = cardUrlKey(url);
    if (key && !urls.has(key)) urls.set(key, url);
  }
  return [...urls.values()];
}

/** Only a single known target is locally predictable. Other changes ask Telegram for its selection. */
export function stableAutomaticInput(post: PublishedPost, url: string, value: string, entities: Api.TypeMessageEntity[]): boolean {
  const candidates = cardUrls(post);
  if (candidates.length !== 1 || !sameCardUrl(candidates[0], url)) return false;
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
