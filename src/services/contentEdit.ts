import { sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import { isCaption, semanticFields, validateUrl, type PostEditState, type PostTarget } from './linkEdit.js';
import { boundaries, checkSpans, coverageEntities, describeEntity, entityOf, invalid, isAutomatic, isStyle, parseSpans, type Span, type Style } from './postEntities.js';

export const CONTENT_EDIT = 'edit_content';
export const contentOps = ['replace_range', 'add_format', 'remove_format', 'replace_content', 'clear_caption', 'replace_visible_url'] as const;
export type ContentOp = typeof contentOps[number];
export interface ContentArgs {
  op: ContentOp;
  find?: string; replacement?: string; selector?: string; occurrence?: number; style?: Style; entities_json?: string;
  old_url?: string; new_url?: string; all?: boolean;
}
export interface ContentPlan extends PostTarget {
  version: 3 | 4; op: ContentOp; telegramUserId: string; revision: string;
  value: string; spans: Span[]; expected: ReturnType<typeof semanticFields>;
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

/** Compare lexical context on each side of a server-generated entity. Punctuation can join URL paths.
 * Phone and bank-card entities can also extend through spaces and number separators.
 */
function tokenEdges(value: string, span: Span) {
  const left = value.slice(0, span.offset);
  const right = value.slice(span.offset + span.length);
  const numeric = span.type === 'phone' || span.type === 'bank_card';
  const edges = {
    left: (numeric ? /[0-9 ()+.\t-]*$/u : /[^ \t\r\n]*$/u).exec(left)![0],
    right: (numeric ? /^[0-9 ()+.\t-]*/u : /^[^ \t\r\n]*/u).exec(right)![0],
  };
  if (numeric && !edges.left.trim()) edges.left = '';
  if (numeric && !edges.right.trim()) edges.right = '';
  return edges;
}

function unsafeBoundary(type: string): never {
  return invalid('The edit could change the detected boundary of a visible ' + type +
    '. Separate the token with whitespace or explicitly replace the full content and its complete entities.');
}

function checkPatchedBoundary(before: string, after: string, prior: Span, next: Span) {
  if (!isAutomatic(prior.type)) return;
  const source = tokenEdges(before, prior);
  const result = tokenEdges(after, next);
  if ((result.left && result.left !== source.left) || (result.right && result.right !== source.right)) unsafeBoundary(prior.type);
}

function checkReplacementBoundaries(before: string, original: Span[], after: string, spans: Span[]) {
  const signature = (value: string, span: Span) => JSON.stringify([
    span.type, value.slice(span.offset, span.offset + span.length), tokenEdges(value, span),
  ]);
  const source = original.filter(s => isAutomatic(s.type));
  const known = new Set(source.map(s => signature(before, s)));
  for (const s of spans.filter(s => isAutomatic(s.type))) {
    const edge = tokenEdges(after, s);
    if ((edge.left || edge.right) && !known.has(signature(after, s))) unsafeBoundary(s.type);
  }
  // Dropping the span from the input does not stop Telegram autolinking surviving text.
  // Require an explicit destination/range (or explicit literal code) for retained tokens.
  const explicit = spans.filter(s => isAutomatic(s.type) || ['text_url', 'pre', 'code', 'mention_name'].includes(s.type));
  for (const token of new Set(source.map(s => before.slice(s.offset, s.offset + s.length)))) {
    if (!token) continue;
    for (let start = after.indexOf(token); start !== -1; start = after.indexOf(token, start + token.length)) {
      if (!explicit.some(s => s.offset <= start && s.offset + s.length >= start + token.length)) {
        invalid('An existing automatic token is still visible. Describe its complete entity in entities_json or remove the token from the replacement.');
      }
    }
  }
}

function patchRange(before: string, after: string, spans: Span[], r: Range, replacement: string, visible: boolean): Span[] {
  const delta = replacement.length - (r.end - r.start);
  return spans.flatMap(s => {
    const end = s.offset + s.length;
    if (end <= r.start || s.offset >= r.end) {
      const next = s.offset >= r.end && delta ? { ...s, offset: s.offset + delta } : s;
      checkPatchedBoundary(before, after, s, next);
      return [next];
    }
    if (s.offset > r.start || end < r.end) invalid('The edit crosses an entity boundary. Narrow find or explicitly replace the complete content.');
    if (!isStyle(s.type) && s.type !== 'text_url' && !(visible && s.type === 'url' && s.offset === r.start && end === r.end)) {
      invalid('Changing text inside ' + s.type + ' requires an explicit entity replacement.');
    }
    return s.length + delta ? [{ ...s, length: s.length + delta }] : [];
  });
}

function formatRange(value: string, spans: Span[], r: Range, style: Style, add: boolean): Span[] {
  const overlaps = (s: Span) => s.type === style && s.offset < r.end && s.offset + s.length > r.start;
  if (add) {
    if (spans.some(s => overlaps(s) && s.offset <= r.start && s.offset + s.length >= r.end)) return spans;
    if (spans.some(overlaps)) invalid('The requested style already partially overlaps this range.');
    return [...spans, { type: style, offset: r.start, length: r.end - r.start }];
  }
  return spans.flatMap(s => {
    if (!overlaps(s)) return [s];
    const parts = [];
    if (s.offset < r.start) {
      const length = value.slice(s.offset, r.start).trimEnd().length;
      if (length) parts.push({ ...s, length });
    }
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
    checkReplacementBoundaries(before, original, value, spans);
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
        spans = formatRange(value, spans, r, a.style!, a.op === 'add_format');
      } else {
        const replacement = a.replacement ?? a.new_url!;
        const after = value.slice(0, r.start) + replacement + value.slice(r.end);
        spans = patchRange(value, after, spans, r, replacement, a.op === 'replace_visible_url');
        value = after;
      }
    }
  }
  if (!value.length && a.op !== 'clear_caption') invalid('Use clear_caption to remove a caption. Text posts must contain text.');
  if (value.length && !value.trim().length) invalid('Whitespace-only content cannot be submitted losslessly.');
  if (/\p{Cs}/u.test(value)) invalid('Content contains an unpaired surrogate.');
  spans = checkSpans(value, spans);
  const expected = semanticFields(state.post, coverageEntities(spans.map(entityOf)), value);
  const plan: ContentPlan = {
    ...state.target, version: 4, op: a.op, telegramUserId: state.telegramUserId,
    revision: state.revision, value, spans, expected
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
