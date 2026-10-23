/**
 * Parses tool arguments. Schemas are flat (strings, numbers, enums), so
 * dates arrive as strings and are converted here to Unix seconds.
 */
import { GatewayError } from '../core/errors.js';

const RELATIVE_RE = /^(\d{1,4})\s*(m|min|h|d|w|mo|y)$/i;
/** `m` means minutes; `mo` means a 30-day month, and a year is 365 days. */
const UNIT_SECONDS: Record<string, number> = { m: 60, min: 60, h: 3600, d: 86_400, w: 604_800, mo: 30 * 86_400, y: 365 * 86_400 };

/** Validate calendar components before Date.parse can normalize them. */
function validCalendarDate(text: string): boolean {
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/**
 * Timestamp: `30d`, `12h`, `2w`, `6mo`, `1y` (relative to now), a date
 * such as `2026-09-01`, an ISO datetime, or Unix seconds. Returns Unix seconds.
 */
function parseWhen(value: string, nowMs: number, argName: string): number {
  const text = value.trim();
  const fail = (): never => {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Invalid "${argName}": "${text.slice(0, 40)}". Use a relative period (30d, 12h, 2w, 6mo, 1y), a date (2026-09-01) or an ISO date-time (2026-09-01T12:00:00Z).`,
    );
  };

  const relative = text.match(RELATIVE_RE);
  if (relative) {
    return Math.floor(nowMs / 1000) - Number(relative[1]) * UNIT_SECONDS[relative[2]!.toLowerCase()]!;
  }
  if (/^\d{9,11}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!validCalendarDate(text)) return fail();
    const ms = Date.parse(`${text}T00:00:00Z`);
    return Number.isNaN(ms) ? fail() : Math.floor(ms / 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    if (!validCalendarDate(text)) return fail();
    // Treat dates without a timezone as UTC, matching gateway output.
    const iso = text.replace(' ', 'T');
    const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
    return Number.isNaN(ms) ? fail() : Math.floor(ms / 1000);
  }
  return fail();
}

export interface DateWindow {
  minDate?: number;
  maxDate?: number;
}

export function parseWindow(since: string | undefined, until: string | undefined, nowMs: number): DateWindow {
  const minDate = since ? parseWhen(since, nowMs, 'since') : undefined;
  const maxDate = until ? parseWhen(until, nowMs, 'until') : undefined;
  if (minDate !== undefined && maxDate !== undefined && minDate >= maxDate) {
    throw new GatewayError('INVALID_ARGUMENT', '"since" must be earlier than "until".');
  }
  return { minDate, maxDate };
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

/** Human-readable date window for response headers. */
export function describeWindow(window: DateWindow): string {
  const fmt = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (window.minDate !== undefined && window.maxDate !== undefined) return ` from ${fmt(window.minDate)} to ${fmt(window.maxDate)}`;
  if (window.minDate !== undefined) return ` since ${fmt(window.minDate)}`;
  if (window.maxDate !== undefined) return ` until ${fmt(window.maxDate)}`;
  return '';
}

/** A number from 0 to max, allowing zero for additional-message counts. */
export function clampCount(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), max);
}
