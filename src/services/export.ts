/**
 * File exports (decision 8). Hundreds of listings exceed agent context,
 * and code aggregates them more reliably than a model. Write JSONL or CSV
 * and return the path, row count, columns, and a few examples.
 *
 * Keep original text; agents interpret prices and listing types.
 * Hash authors and mask phones unless the owner explicitly asks otherwise.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import { totalReactions } from '../core/reactions.js';
import type { SharedFiles } from '../core/safeFs.js';
import type { TgCallOptions } from '../core/tg.js';
import { sanitizeText } from '../policy/envelope.js';
import type { EntityRecord, Storage } from '../storage/port.js';
import type { HistoryService } from './history.js';
import type { JobContext } from './jobs.js';
import { messageLink } from './links.js';
import type { MediaService } from './media.js';
import type { MessageDto } from './messages.js';
import { maskPhones } from './phones.js';
import type { SearchService } from './search.js';

export type ExportFormat = 'jsonl' | 'csv';

export interface ExportParams {
  accountId: string;
  chatKey: string;
  query?: string;
  topicId?: number;
  minDate?: number;
  maxDate?: number;
  format: ExportFormat;
  maxRows: number;
  /** Download photo previews and place paths in photo_path. */
  photos: 'none' | 'thumb';
  /** Keep author identifiers and phone numbers only on explicit owner request. */
  includeContacts: boolean;
}

export interface ExportRow {
  id: number;
  date: string;
  topic_id: number | null;
  author: string;
  text: string;
  views: number | null;
  replies: number | null;
  reactions: number;
  media: string | null;
  album_id: string | null;
  link: string | null;
  photo_path: string | null;
}

const EXPORT_COLUMNS: Array<keyof ExportRow> = [
  'id',
  'date',
  'topic_id',
  'author',
  'text',
  'views',
  'replies',
  'reactions',
  'media',
  'album_id',
  'link',
  'photo_path',
];

export const EXPORT_MAX_ROWS = 10_000;
const MAX_PHOTOS = 300;
const SAMPLE_ROWS = 5;
const SAMPLE_TEXT_CHARS = 200;

export interface ExportResult extends Record<string, unknown> {
  path: string;
  format: ExportFormat;
  rows: number;
  scanned: number;
  photos: number;
  /** Export stopped at the row cap; more chat messages remain. */
  truncated: boolean;
  date_from: string | null;
  date_to: string | null;
  columns: string[];
  samples: ExportRow[];
  /** Present when the media directory was refused; later photos were not attempted. */
  photos_refused?: string;
}

/** CSV cell following RFC 4180. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Prevent Telegram text from becoming formulas when opened in a spreadsheet.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function slugify(text: string, maxChars = 40): string {
  const slug = text
    .toLowerCase()
    // Preserve Cyrillic filename support using explicit Unicode character ranges.
    .replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxChars).replace(/-+$/, '') || 'export';
}

export interface ExportServiceDeps {
  storage: Storage;
  history: HistoryService;
  search: SearchService;
  media: MediaService;
  /** Shared gateway directory; exports are stored in `<root>/exports`. */
  files: SharedFiles;
  now?: () => number;
}

export class ExportService {
  private readonly now: () => number;

  constructor(private readonly deps: ExportServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** One gateway-wide salt keeps author hashes consistent between exports. */
  private salt(): string {
    const key = 'export.author_salt';
    let salt = this.deps.storage.kv.get(key);
    if (!salt) {
      salt = randomToken(16);
      this.deps.storage.kv.set(key, salt);
    }
    return salt;
  }

  authorLabel(message: MessageDto, includeContacts: boolean): string {
    const key = message.author.peerKey ?? 'anonymous';
    if (includeContacts) {
      return message.author.username ? `@${message.author.username}` : `${message.author.name ?? 'unknown'} (${key})`;
    }
    return key === 'anonymous' ? 'anonymous' : 'a_' + sha256Hex(`${this.salt()}:${key}`).slice(0, 12);
  }

  toRow(message: MessageDto, chat: EntityRecord, includeContacts: boolean): ExportRow {
    const clean = sanitizeText(message.text);
    return {
      id: message.id,
      date: new Date(message.date * 1000).toISOString(),
      topic_id: message.topicId,
      author: this.authorLabel(message, includeContacts),
      text: includeContacts ? clean : maskPhones(clean),
      views: message.views,
      replies: message.replies,
      reactions: totalReactions(message.reactions),
      media: message.media?.kind ?? null,
      album_id: message.groupedId,
      link: messageLink({ username: chat.username, peerKey: chat.peerKey, messageId: message.id, topicId: message.topicId ?? undefined }),
      photo_path: null,
    };
  }

  /** Export job executor; parameters come from `job.params`. */
  async run(context: JobContext): Promise<ExportResult> {
    const params = context.job.params as unknown as ExportParams;
    const chat = this.deps.storage.entities.get(params.accountId, params.chatKey);
    if (!chat) {
      throw new GatewayError('CHAT_NOT_FOUND', `Chat ${params.chatKey} is not in the cache of account ${params.accountId}. Resolve it with tg_resolve first.`);
    }
    const maxRows = Math.min(Math.max(1, params.maxRows), EXPORT_MAX_ROWS);
    // Exports run in the background so agent calls can use the foreground queue.
    const call: TgCallOptions = { priority: 'background' };

    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    // Random filename suffix prevents path prediction and pre-creation.
    const name = `${stamp}-${slugify([chat.username ?? chat.peerKey, params.query ?? ''].join(' '))}-${randomBytes(3).toString('hex')}.${params.format}`;
    const path = join(this.deps.files.root, 'exports', context.job.userId, name);
    const fd = await this.deps.files.openNewFile(path, 0o644);
    let rows = 0;
    let scanned = 0;
    let photos = 0;
    // A refused media directory refuses every later photo too; checking it again per photo only repeats the refusal.
    let photosRefused: string | undefined;
    let truncated = false;
    let newest: number | null = null;
    let oldest: number | null = null;
    const samples: ExportRow[] = [];

    try {
      if (params.format === 'csv') writeSync(fd, EXPORT_COLUMNS.join(',') + '\n');

      let offsetId = 0;
      for (;;) {
        if (context.stopping()) break;
        const page = params.query
          ? await this.deps.search.inChat(
              params.accountId,
              chat,
              { query: params.query, limit: 100, offsetId, minDate: params.minDate, maxDate: params.maxDate, topicId: params.topicId },
              call,
            )
          : await this.deps.history.page(
              params.accountId,
              chat,
              { limit: 100, offsetId, minDate: params.minDate, maxDate: params.maxDate, topicId: params.topicId },
              call,
            );

        scanned += page.messages.length;
        const rawById = new Map<number, unknown>();
        for (const raw of page.raw) {
          const id = (raw as { id?: number }).id;
          if (typeof id === 'number') rawById.set(id, raw);
        }

        const lines: string[] = [];
        for (const message of page.messages) {
          if (message.service !== null || (message.text === '' && message.media === null)) continue;
          if (rows >= maxRows) {
            truncated = true;
            break;
          }
          const row = this.toRow(message, chat, params.includeContacts);

          if (params.photos === 'thumb' && message.media?.kind === 'photo' && photos < MAX_PHOTOS && photosRefused === undefined) {
            const raw = rawById.get(message.id);
            if (raw) {
              const downloaded = await this.deps.media.download(params.accountId, chat.peerKey, [raw], 'thumb', call);
              photosRefused = downloaded.refused;
              if (downloaded.files[0]) {
                row.photo_path = downloaded.files[0].path;
                photos++;
              }
            }
          }

          newest = newest === null ? message.date : Math.max(newest, message.date);
          oldest = oldest === null ? message.date : Math.min(oldest, message.date);
          if (samples.length < SAMPLE_ROWS) {
            samples.push({ ...row, text: row.text.length > SAMPLE_TEXT_CHARS ? row.text.slice(0, SAMPLE_TEXT_CHARS) + '…' : row.text });
          }
          lines.push(params.format === 'csv' ? EXPORT_COLUMNS.map(c => csvCell(row[c])).join(',') : JSON.stringify(row));
          rows++;
        }
        if (lines.length > 0) writeSync(fd, lines.join('\n') + '\n');
        context.progress({ rows, scanned, photos, total: page.total });

        if (truncated || page.nextOffsetId === null) break;
        offsetId = page.nextOffsetId;
      }
    } finally {
      closeSync(fd);
      chmodSync(path, 0o644);
    }

    return {
      path,
      format: params.format,
      rows,
      scanned,
      photos,
      truncated,
      date_from: oldest === null ? null : new Date(oldest * 1000).toISOString(),
      date_to: newest === null ? null : new Date(newest * 1000).toISOString(),
      columns: EXPORT_COLUMNS,
      samples,
      ...(photosRefused === undefined ? {} : { photos_refused: photosRefused }),
    };
  }
}
