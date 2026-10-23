/**
 * Masks phone numbers in exported text, retaining the first two and last two
 * digits. Seller phone numbers must not enter files or agent context
 * unless the owner explicitly requests them.
 */

/**
 * Phone digit-group separator: space, hyphen, or a hyphen surrounded by spaces.
 * Hyphen variants include nonbreaking hyphen (U+2011),
 * figure dash (U+2012), en dash (U+2013), and minus sign (U+2212).
 */
const PHONE_GAP = String.raw`(?:[ \u00A0\u202F]?[\-\u2011\u2012\u2013\u2212]?[ \u00A0\u202F]?)`;

/**
 * Phone numbers have two accepted forms:
 * 1. International: + followed by 10-15 digits with optional spaces,
 *    hyphens, and parentheses (+7 999 123-45-67, +1 (415) 555-2671).
 * 2. Without +: exactly 11 digits beginning with 7 or 8; a consecutive
 *    three-digit code, optionally parenthesized, starts with 0, 3, 4, 7, 8, or 9.
 *    Examples: 8 (999) 123-45-67, 89991234567, Belarusian 8 029 ... .
 *    The remaining seven digits use 3-2-2, 3-4, 2-2-3, 4-3, or no separators.
 *    These constraints exclude prices such as 8 500 000 or 7 800 000 4 000 000.
 * No letter, digit, _, +, or # may precede a match (IDs and hashtags);
 * no digit may follow it (excluding 16-digit cards and long IDs).
 */
const PHONE_SRC =
  String.raw`(?<![\p{L}\p{N}_+#])(?:(\+\d(?:${PHONE_GAP}\(?\d\)?){9,14})` +
  String.raw`|[78]${PHONE_GAP}\(?[034789]\d{2}\)?${PHONE_GAP}` +
  String.raw`(?:\d{3}${PHONE_GAP}\d{2}${PHONE_GAP}\d{2}|\d{3}${PHONE_GAP}\d{4}|\d{2}${PHONE_GAP}\d{2}${PHONE_GAP}\d{3}|\d{4}${PHONE_GAP}\d{3}))(?!\d)`;

/**
 * Number length including country code prevents international matches
 * from consuming a following price: +7 999 123-45-67 25 000 RUB.
 */
const PHONE_LENGTHS: ReadonlyArray<readonly [string, number]> = [
  ['380', 12],
  ['375', 12],
  ['374', 11],
  ['373', 11],
  ['995', 12],
  ['994', 12],
  ['996', 12],
  ['998', 12],
  ['992', 12],
  ['993', 11],
  ['971', 12],
  ['972', 12],
  ['90', 12],
  ['44', 12],
  ['48', 11],
  ['7', 11],
  ['1', 11],
];

interface Span {
  start: number;
  end: number;
}

/** Match length to retain when an unrelated number follows the phone. */
function internationalPhoneLength(match: string): number {
  const digits = match.replace(/\D/g, '');
  const known = PHONE_LENGTHS.find(([code]) => digits.startsWith(code));
  if (!known || digits.length <= known[1]) return match.length;
  let seen = 0;
  for (let i = 0; i < match.length; i++) {
    if (!/\d/.test(match[i]!)) continue;
    seen++;
    if (seen === known[1]) {
      // Consecutive extra digits invalidate this country length; keep the full match.
      return /\d/.test(match[i + 1] ?? '') ? match.length : i + 1;
    }
  }
  return match.length;
}

function findPhoneSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(PHONE_SRC, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const length = m[1] !== undefined ? internationalPhoneLength(m[1]) : m[0].length;
    const end = m.index + length;
    spans.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return spans;
}

function maskDigits(phone: string): string {
  const total = phone.replace(/\D/g, '').length;
  let seen = 0;
  return phone.replace(/\d/g, digit => {
    seen++;
    return seen <= 2 || seen > total - 2 ? digit : '*';
  });
}

/**
 * Masks phones while retaining the first two and last two digits and
 * punctuation: +7 999 123-45-67 becomes +7 9** ***-**-67.
 */
export function maskPhones(text: string): string {
  if (!text) return text;
  const spans = findPhoneSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const span of spans) {
    out += text.slice(pos, span.start) + maskDigits(text.slice(span.start, span.end));
    pos = span.end;
  }
  return out + text.slice(pos);
}
