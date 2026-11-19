/** Portable, lossless entity descriptions for edit previews and immutable approvals. */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import { validateUrl } from './linkEdit.js';

export function invalid(message: string): never { throw new GatewayError('INVALID_ARGUMENT', message); }

const simple = {
  bold: Api.MessageEntityBold, italic: Api.MessageEntityItalic, underline: Api.MessageEntityUnderline,
  strike: Api.MessageEntityStrike, spoiler: Api.MessageEntitySpoiler, code: Api.MessageEntityCode,
  url: Api.MessageEntityUrl, mention: Api.MessageEntityMention, hashtag: Api.MessageEntityHashtag,
  bot_command: Api.MessageEntityBotCommand, email: Api.MessageEntityEmail, phone: Api.MessageEntityPhone,
  cashtag: Api.MessageEntityCashtag, bank_card: Api.MessageEntityBankCard,
};
const simpleTypes = new Map(Object.entries(simple).map(([type, C]) => [new C({ offset: 0, length: 1 }).className as string, type]));
const dateFlags = ['relative', 'shortTime', 'longTime', 'shortDate', 'longDate', 'dayOfWeek'] as const;
const spanSchema = z.strictObject({
  type: z.string(), offset: z.number().int().nonnegative(), length: z.number().int().positive(),
  url: z.string().optional(), language: z.string().optional(), collapsed: z.boolean().optional(),
  user_id: z.string().optional(), document_id: z.string().optional(), date: z.number().int().min(-2147483648).max(2147483647).optional(),
  flags: z.array(z.enum(dateFlags)).optional(),
});
export type Span = z.infer<typeof spanSchema>;
export const styles = ['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'pre', 'blockquote'] as const;
export type Style = typeof styles[number];
const decorative = new Set<string>(styles.slice(0, 5));
const automatic = new Set(['url', 'mention', 'hashtag', 'bot_command', 'email', 'phone', 'cashtag', 'bank_card']);
export function isAutomatic(type: string): boolean { return automatic.has(type); }
export function isStyle(type: string): boolean { return (styles as readonly string[]).includes(type); }

/** Compare the covered UTF-16 intervals of splittable styles; every other constructor stays exact. */
export function coverageEntities(entities: Api.TypeMessageEntity[]): Api.TypeMessageEntity[] {
  const strict: Api.TypeMessageEntity[] = [];
  const byStyle = new Map<string, Span[]>();
  for (const entity of entities) {
    const type = simpleTypes.get(entity.className);
    if (!type || !decorative.has(type)) {
      strict.push(entity);
      continue;
    }
    const intervals = byStyle.get(type) ?? [];
    intervals.push({ type, offset: entity.offset, length: entity.length });
    byStyle.set(type, intervals);
  }
  for (const intervals of byStyle.values()) {
    let last: Span | undefined;
    for (const s of intervals.sort((a, b) => a.offset - b.offset)) {
      if (last && s.offset <= last.offset + last.length) {
        last.length = Math.max(last.length, s.offset + s.length - last.offset);
      } else {
        if (last) strict.push(entityOf(last));
        last = s;
      }
    }
    if (last) strict.push(entityOf(last));
  }
  return strict;
}

/** TDLib's MAX_USER_ENTITY_COUNT covers manual non-emoji entities, including styles. */
export function checkEntityRules(spans: Span[]) {
  let manual = 0;
  for (const s of spans) {
    if (!isAutomatic(s.type) && s.type !== 'custom_emoji') manual++;
    if (s.type !== 'formatted_date') continue;
    const flags = new Set(s.flags);
    if ((flags.has('relative') && flags.size > 1) || (flags.has('shortTime') && flags.has('longTime')) ||
        (flags.has('shortDate') && flags.has('longDate'))) invalid('Incompatible formatted_date flags.');
    const max = flags.size ? 31 : 127;
    if (s.length > max) invalid('formatted_date exceeds its limit of ' + max + ' UTF-16 units.');
  }
  if (manual > 100) invalid('The outgoing edit exceeds the limit of 100 manual non-emoji entities.');
}

export function describeEntity(e: Api.TypeMessageEntity): Span {
  const range = { offset: e.offset, length: e.length };
  switch (e.className) {
    case 'MessageEntityPre': return { ...range, type: 'pre', language: e.language };
    case 'MessageEntityTextUrl': return { ...range, type: 'text_url', url: e.url };
    case 'MessageEntityMentionName': return { ...range, type: 'mention_name', user_id: e.userId.toString() };
    case 'MessageEntityCustomEmoji': return { ...range, type: 'custom_emoji', document_id: e.documentId.toString() };
    case 'MessageEntityBlockquote': return { ...range, type: 'blockquote', collapsed: !!e.collapsed };
    case 'MessageEntityFormattedDate': return { ...range, type: 'formatted_date', date: e.date, flags: dateFlags.filter(f => e[f]) };
    default: {
      const type = simpleTypes.get(e.className);
      if (!type) invalid('Unsupported entity: ' + e.className);
      return { ...range, type };
    }
  }
}

function id64(value: string | undefined, signed = false) {
  if (!value || !/^-?[1-9]\d{0,18}$/.test(value)) invalid('An entity ID must be a nonzero decimal int64 string.');
  const id = BigInt(value);
  if (id > 9223372036854775807n || id < (signed ? -9223372036854775808n : 1n)) invalid('Entity ID is out of range.');
  return bigInt(value);
}

export function entityOf(s: Span): Api.TypeMessageEntity {
  const r = { offset: s.offset, length: s.length };
  if (Object.hasOwn(simple, s.type)) return new simple[s.type as keyof typeof simple](r);
  switch (s.type) {
    case 'pre': return new Api.MessageEntityPre({ ...r, language: s.language ?? '' });
    case 'blockquote': return new Api.MessageEntityBlockquote({ ...r, collapsed: s.collapsed || undefined });
    case 'text_url':
      if (!s.url) invalid('text_url requires url.');
      return new Api.MessageEntityTextUrl({ ...r, url: s.url });
    case 'mention_name': return new Api.MessageEntityMentionName({ ...r, userId: id64(s.user_id) });
    case 'custom_emoji': return new Api.MessageEntityCustomEmoji({ ...r, documentId: id64(s.document_id, true) });
    case 'formatted_date':
      if (s.date === undefined) invalid('formatted_date requires date.');
      return new Api.MessageEntityFormattedDate({ ...r, date: s.date, ...Object.fromEntries((s.flags ?? []).map(f => [f, true])) });
    default: return invalid('Unsupported entity type: ' + s.type);
  }
}

export function parseSpans(json: string): Span[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { invalid('entities_json must contain a JSON array.'); }
  const parsed = z.array(spanSchema).safeParse(data);
  if (!parsed.success) invalid('Invalid entities_json. Each entity requires type, offset and length, with type-specific attributes.');
  const attributes: Record<string, string[]> = {
    text_url: ['url'], pre: ['language'], blockquote: ['collapsed'],
    mention_name: ['user_id'], custom_emoji: ['document_id'], formatted_date: ['date', 'flags']
  };
  for (const s of parsed.data) {
    const allowed = ['type', 'offset', 'length', ...(Object.hasOwn(attributes, s.type) ? attributes[s.type] : [])];
    if (Object.keys(s).some(key => !allowed.includes(key))) invalid('Unexpected attribute for ' + s.type);
    if (s.type === 'text_url') validateUrl(s.url ?? '');
    if (s.language && /\p{Cs}/u.test(s.language)) invalid('Invalid Unicode in pre language.');
    entityOf(s);
  }
  return parsed.data;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function boundaries(value: string): Map<number, number> {
  const points = new Map<number, number>();
  for (const segment of graphemes.segment(value)) points.set(segment.index, segment.index + segment.segment.length);
  points.set(value.length, value.length);
  return points;
}

export function checkSpans(value: string, spans: Span[]) {
  const points = boundaries(value);
  const ordered = [...spans].sort((a, b) => a.offset - b.offset || b.length - a.length ||
    Number(b.type === 'blockquote') - Number(a.type === 'blockquote'));
  for (const [i, s] of ordered.entries()) {
    const end = s.offset + s.length;
    if (s.length <= 0 || !points.has(s.offset) || !points.has(end)) invalid('Entity range is invalid or splits a grapheme.');
    if (/\s$/u.test(value.slice(s.offset, end))) invalid('An entity ends in whitespace. Select the exact styled text.');
    if (s.type === 'custom_emoji' && points.get(s.offset) !== end) invalid('A custom emoji covers one grapheme.');
    for (let j = i + 1; j < ordered.length && ordered[j].offset < end; j++) {
      const child = ordered[j];
      const preformatted = (type: string) => type === 'pre' || type === 'code';
      if (child.offset + child.length > end || child.type === s.type || preformatted(s.type) ||
        (preformatted(child.type) && s.type !== 'blockquote') ||
        (!decorative.has(s.type) && !decorative.has(child.type) && s.type !== 'blockquote')) {
        invalid('Overlapping or incompatible entities: ' + s.type + ' / ' + child.type);
      }
    }
  }
  return ordered;
}
