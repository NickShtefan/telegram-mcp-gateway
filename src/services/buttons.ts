/**
 * Message inline buttons (decision 31). Agents see kinds, labels, keyboard
 * positions, and destinations for URL buttons. Callback bytes are never
 * exposed; the gateway constructs presses from a freshly read message.
 *
 * Layer 229 represents keyboards as ReplyInlineMarkup with KeyboardInlineButtonRow;
 * button kinds are in the type field (InlineButtonTypeCallback and others).
 */
import { createHash } from 'node:crypto';

export type ButtonKind = 'callback' | 'url' | 'login' | 'webapp' | 'switch_inline' | 'game' | 'buy' | 'profile' | 'copy' | 'disabled' | 'other';

export interface ButtonDto {
  kind: ButtonKind;
  /** Untrusted button label. */
  text: string;
  /** Callback button requiring the account's 2FA password. */
  needsPassword: boolean;
  /** Untrusted destination for URL, web sign-in, or web-app buttons. */
  url: string | null;
}

const KINDS: Record<string, ButtonKind> = {
  InlineButtonTypeCallback: 'callback',
  InlineButtonTypeUrl: 'url',
  InlineButtonTypeUrlAuth: 'login',
  InputInlineButtonTypeUrlAuth: 'login',
  InlineButtonTypeWebView: 'webapp',
  InlineButtonTypeSwitchInline: 'switch_inline',
  InlineButtonTypeGame: 'game',
  InlineButtonTypeBuy: 'buy',
  InlineButtonTypeUserProfile: 'profile',
  InputInlineButtonTypeUserProfile: 'profile',
  InlineButtonTypeCopy: 'copy',
  InlineButtonTypeDisabled: 'disabled',
};

interface RawButton {
  text?: unknown;
  type?: { className?: string; data?: unknown; requiresPassword?: boolean; url?: unknown } | null;
}

interface RawMarkup {
  className?: string;
  rows?: Array<{ buttons?: Array<RawButton | null> } | null>;
}

function inlineRows(replyMarkup: unknown): RawButton[][] {
  const markup = replyMarkup as RawMarkup | null;
  if (!markup || typeof markup !== 'object' || markup.className !== 'ReplyInlineMarkup' || !Array.isArray(markup.rows)) return [];
  // Preserve row and column positions for execution-time lookup.
  return markup.rows.map(row => (Array.isArray(row?.buttons) ? row.buttons.map(b => b ?? {}) : []));
}

function toDto(button: RawButton): ButtonDto {
  return {
    kind: KINDS[button.type?.className ?? ''] ?? 'other',
    text: typeof button.text === 'string' ? button.text : '',
    needsPassword: button.type?.requiresPassword === true,
    url: typeof button.type?.url === 'string' && button.type.url !== '' ? button.type.url : null,
  };
}

/** Message inline keyboard rows, or an empty list when absent. */
export function normalizeButtons(replyMarkup: unknown): ButtonDto[][] {
  return inlineRows(replyMarkup).map(row => row.map(toDto));
}

export interface LocatedButton extends ButtonDto {
  /** Callback bytes, available only for callback buttons. */
  data: Buffer | null;
  /** Fingerprint detecting changes between preview and execution. */
  fingerprint: string;
}

/** Raw message button at a one-based row/column, or null when absent. */
export function buttonAt(rawMessage: unknown, row: number, position: number): LocatedButton | null {
  const raw = inlineRows((rawMessage as { replyMarkup?: unknown } | null)?.replyMarkup)[row - 1]?.[position - 1];
  if (!raw) return null;
  const dto = toDto(raw);
  const bytes = raw.type?.data;
  const data = dto.kind === 'callback' && bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
  const fingerprint = createHash('sha256')
    .update(`${dto.kind}\n${dto.text}\n`)
    .update(data ?? Buffer.alloc(0))
    .digest('hex');
  return { ...dto, data, fingerprint };
}
