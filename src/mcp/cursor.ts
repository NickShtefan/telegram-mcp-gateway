/**
 * Opaque cursors. Agents return these strings unchanged; internally they
 * contain Telegram result positions (offsetId, offsetRate, offsetPeer).
 */
import { GatewayError } from '../core/errors.js';

const PREFIX = 'c1.';

export type CursorData = Record<string, string | number | boolean | null>;

export function encodeCursor(kind: string, data: CursorData): string {
  return PREFIX + Buffer.from(JSON.stringify([kind, data]), 'utf8').toString('base64url');
}

/** Parses a cursor and checks its tool-kind tag; this is not proof of origin. */
export function decodeCursor<T extends CursorData>(kind: string, cursor: string): T {
  const fail = (): never => {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      'Invalid cursor. Pass next_cursor exactly as it was returned by the previous call of the same tool, or omit it to start over.',
    );
  };
  if (typeof cursor !== 'string' || !cursor.startsWith(PREFIX)) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return fail();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== kind) return fail();
  const data = parsed[1];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  return data as T;
}
