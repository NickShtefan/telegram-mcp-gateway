import { sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import { isCaption, semanticFields, validateUrl, type PostEditState, type PostTarget } from './linkEdit.js';
import { boundaries, checkSpans, describeEntity, entityOf, invalid, isStyle, parseSpans, type Span, type Style } from './postEntities.js';

export const CONTENT_EDIT = 'edit_content';
export const contentOps = ['replace_range', 'add_format', 'remove_format', 'replace_content', 'clear_caption', 'replace_visible_url'] as const;
export type ContentOp = typeof contentOps[number];
export interface ContentArgs {
  op: ContentOp;
  find?: string; replacement?: string; selector?: string; occurrence?: number; style?: Style; entities_json?: string;
  old_url?: string; new_url?: string; all?: boolean;
}
export interface ContentPlan extends PostTarget {
  version: 3; op: ContentOp; telegramUserId: string; revision: string;
  value: string; spans: Span[]; expected: ReturnType<typeof semanticFields>;
  newEmoji: { id: string; glyph: string }[];
}

function addedEmoji(before: string, original: Span[], after: string, updated: Span[]) {
  const entries = (value: string, spans: Span[]) => spans.filter(s => s.type === 'custom_emoji').map(s =>
    ({ id: s.document_id!, glyph: value.slice(s.offset, s.offset + s.length) }));
  const counts = new Map<string, number>();
  for (const emoji of entries(before, original)) {
    const key = JSON.stringify(emoji);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries(after, updated).filter(emoji => {
    const key = JSON.stringify(emoji);
    const remaining = counts.get(key) ?? 0;
    counts.set(key, remaining - 1);
    return remaining <= 0;
  });
}

const allowed: Record<ContentOp, string[]> = {
  replace_range: ['find', 'replacement', 'selector', 'occurrence'], add_format: ['find', 'style', 'selector', 'occurrence'],
  remove_format: ['find', 'style', 'selector', 'occurrence'], replace_content: ['replacement', 'entities_json'], clear_caption: [],
  replace_visible_url: ['old_url', 'new_url', 'selector', 'occurrence', 'all'],
};

function validateArgs(a: ContentArgs) {
  for (const [key, v] of Object.entries(a)) {
    if (key !== 'op' && v !== undefined && !allowed[a.op].includes(key)) invalid(key + ' is not valid for ' + a.op + '.');
  }
  if (a.op === 'replace_range' || a.op === 'replace_content') {
    if (a.replacement === undefined || /\p{Cs}/u.test(a.replacement)) invalid('Supply replacement as well-formed Unicode.');
  }
  if (a.op === 'replace_range' || a.op === 'add_format' || a.op === 'remove_format') {
    if (!a.find) invalid('Supply an exact nonempty find string.');
  }
  if ((a.op === 'add_format' || a.op === 'remove_format') && !a.style) invalid('Supply the formatting style.');
  if (a.op === 'replace_content' && a.entities_json === undefined) invalid('Supply entities_json, including [] to explicitly strip all entities.');
  if (a.occurrence !== undefined && (a.selector !== undefined || a.all)) invalid('Use only one occurrence selection method.');
  if (a.op === 'replace_visible_url') {
    if (!a.old_url || !a.new_url) invalid('Supply old_url and new_url.');
    if (a.all && a.selector !== undefined) invalid('Choose one selector or all matches.');
    validateUrl(a.new_url);
  }
}

interface Range { start: number; end: number }
function occurrences(value: string, spans: Span[], a: ContentArgs): Range[] {
  if (a.op === 'replace_visible_url') {
    return spans.filter(s => s.type === 'url' && value.slice(s.offset, s.offset + s.length) === a.old_url)
      .map(s => ({ start: s.offset, end: s.offset + s.length })).sort((x, y) => x.start - y.start);
  }
  const needle = a.find!;
  const points = boundaries(value);
  const hits: Range[] = [];
  for (let i = value.indexOf(needle); i >= 0; i = value.indexOf(needle, i + 1)) {
    if (points.has(i) && points.has(i + needle.length)) hits.push({ start: i, end: i + needle.length });
  }
  return hits;
}

function patchRange(spans: Span[], r: Range, replacement: string, visible: boolean): Span[] {
  const delta = replacement.length - (r.end - r.start);
  return spans.flatMap(s => {
    const end = s.offset + s.length;
    if (end <= r.start) return [s];
    if (s.offset >= r.end) return delta ? [{ ...s, offset: s.offset + delta }] : [s];
    if (s.offset > r.start || end < r.end) invalid('The edit crosses an entity boundary. Narrow find or explicitly replace the complete content.');
    if (!isStyle(s.type) && s.type !== 'text_url' && !(visible && s.type === 'url' && s.offset === r.start && end === r.end)) {
      invalid('Changing text inside ' + s.type + ' requires an explicit entity replacement.');
    }
    return s.length + delta ? [{ ...s, length: s.length + delta }] : [];
  });
}

function formatRange(spans: Span[], r: Range, style: Style, add: boolean): Span[] {
  const overlaps = (s: Span) => s.type === style && s.offset < r.end && s.offset + s.length > r.start;
  if (add) {
    if (spans.some(s => overlaps(s) && s.offset <= r.start && s.offset + s.length >= r.end)) return spans;
    if (spans.some(overlaps)) invalid('The requested style already partially overlaps this range.');
    return [...spans, { type: style, offset: r.start, length: r.end - r.start }];
  }
  return spans.flatMap(s => {
    if (!overlaps(s)) return [s];
    const parts = [];
    if (s.offset < r.start) parts.push({ ...s, length: r.start - s.offset });
    if (s.offset + s.length > r.end) parts.push({ ...s, offset: r.end, length: s.offset + s.length - r.end });
    return parts;
  });
}

export function assertContentLength(count: number, limit: number): void {
  if (count > limit) invalid('The content exceeds the account limit of ' + limit + ' Unicode code points.');
}

export function prepareContent(state: PostEditState, a: ContentArgs, limit: number) {
  validateArgs(a);
  const before = state.post.message;
  let value = before;
  const original = (state.post.entities ?? []).map(describeEntity);
  let spans = original;
  let ranges: Range[] = [];
  if (a.op === 'clear_caption') {
    if (!isCaption(state.post)) invalid('Only a media caption can be cleared.');
    value = ''; spans = [];
  } else if (a.op === 'replace_content') {
    value = a.replacement!;
    assertContentLength([...value].length, limit);
    spans = parseSpans(a.entities_json!);
  } else {
    const hits = occurrences(before, spans, a);
    const candidates = hits.map(r => ({
      ...r, selector: sha256Hex(JSON.stringify([state.revision, a.op, a.find ?? a.old_url, r.start, r.end])).slice(0, 24),
      before: before.slice(Math.max(0, r.start - 24), r.start), after: before.slice(r.end, r.end + 24)
    }));
    if (a.selector !== undefined) {
      const found = candidates.find(c => c.selector === a.selector);
      if (!found) throw new GatewayError('EDIT_CONFLICT', 'The occurrence selector is stale or belongs to a different operation.');
      ranges = [found];
    } else if (a.occurrence !== undefined) {
      const found = hits[a.occurrence - 1];
      if (!found) invalid('The requested occurrence does not exist.');
      ranges = [found];
    } else if (!hits.length || (hits.length > 1 && !a.all)) {
      return { status: hits.length ? 'choose_range' as const : 'no_match' as const, total: hits.length, candidates: candidates.slice(0, 12) };
    } else ranges = hits;
    // Bound all-matches expansion before constructing the new string or entity vector.
    const newText = a.replacement ?? a.new_url;
    const oldText = a.find ?? a.old_url!;
    const delta = newText === undefined ? 0 : [...newText].length - [...oldText].length;
    assertContentLength([...before].length + ranges.length * delta, limit);
    for (const r of [...ranges].reverse()) {
      if (a.op === 'add_format' || a.op === 'remove_format') {
        spans = formatRange(spans, r, a.style!, a.op === 'add_format');
      } else {
        const replacement = a.replacement ?? a.new_url!;
        spans = patchRange(spans, r, replacement, a.op === 'replace_visible_url');
        value = value.slice(0, r.start) + replacement + value.slice(r.end);
      }
    }
  }
  if (!value.length && a.op !== 'clear_caption') invalid('Use clear_caption to remove a caption. Text posts must contain text.');
  if (value.length && !value.trim().length) invalid('Whitespace-only content cannot be submitted losslessly.');
  if (/\p{Cs}/u.test(value)) invalid('Content contains an unpaired surrogate.');
  spans = checkSpans(value, spans);
  const expected = semanticFields(state.post, spans.map(entityOf), value);
  const plan: ContentPlan = {
    ...state.target, version: 3, op: a.op, telegramUserId: state.telegramUserId,
    revision: state.revision, value, spans, expected, newEmoji: addedEmoji(before, original, value, spans)
  };
  const originalSet = new Set(original);
  const updatedSet = new Set(spans);
  const diff = ranges.length ? {
    occurrences: ranges.map(({ start, end }) => ({
      start, end, text: before.slice(start, end),
      before: before.slice(Math.max(0, start - 24), start), after: before.slice(end, end + 24)
    })),
    ...(a.style ? { style: a.style } : { replacement: a.replacement ?? a.new_url }),
    entities_removed: original.filter(s => !updatedSet.has(s)), entities_added: spans.filter(s => !originalSet.has(s)),
  } : { before, after: value, entities_before: original, entities_after: spans };
  return { status: 'preview' as const, plan, diff };
}
