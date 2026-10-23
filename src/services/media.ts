/**
 * Images and media: photos, albums, and video previews. Files go into a
 * shared directory readable by agents; responses contain file paths.
 *
 * Includes data-center migration retries, on-disk caching, size selection,
 * individual file limits, and directory quotas.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Api } from 'teleproto';
import { createLogger, type Logger } from '../core/log.js';
import type { SharedFiles } from '../core/safeFs.js';
import { sleep } from '../core/time.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import { normalizeMedia, type MediaKind } from './messages.js';

export type MediaSize = 'thumb' | 'full';

export interface MediaFile {
  messageId: number;
  kind: MediaKind;
  size: MediaSize;
  path: string;
  bytes: number;
  mime: string;
  /** File already existed on disk; no Telegram call was made. */
  cached: boolean;
}

export interface MediaSkip {
  messageId: number;
  reason: string;
}

export interface MediaResult {
  files: MediaFile[];
  skipped: MediaSkip[];
  /** Why the chat directory was refused; nothing could be fetched into it during this call. */
  refused?: string;
}

export interface MediaServiceOptions {
  tg: Tg;
  /** Shared gateway directory; media are stored in `<root>/media`. */
  files: SharedFiles;
  /** Maximum full-size file saved or returned from cache; not a download memory cap. */
  maxFullBytes?: number;
  /** Maximum total media directory size. */
  quotaBytes?: number;
  log?: Logger;
  now?: () => number;
}

const DEFAULT_MAX_FULL_BYTES = 20 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const QUOTA_CHECK_EVERY = 50;

/** teleproto may throw a file data-center migration error instead of switching automatically. */
export function isDcRedirectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Actual FileMigrateError text: 'The file currently being accessed is stored in DC N'.
  return /stored in DC/i.test(msg) || /file.*(another|different)\s*dc/i.test(msg) || /dc.*redirect/i.test(msg) || /FILE_MIGRATE/i.test(msg) || /NETWORK_MIGRATE/i.test(msg);
}

interface RawSize {
  className?: string;
  type?: string;
  w?: number;
  h?: number;
}

/**
 * Preview size type around 320 px on the longer side. Returns the size
 * type letter (`m`, `x`, ...) accepted by teleproto's `thumb`, or null.
 */
export function pickThumbType(sizes: unknown): string | null {
  if (!Array.isArray(sizes)) return null;
  const usable = (sizes as RawSize[]).filter(
    s => s && typeof s.type === 'string' && typeof s.w === 'number' && typeof s.h === 'number' && s.className !== 'PhotoStrippedSize' && s.className !== 'PhotoPathSize',
  );
  if (usable.length === 0) return null;
  const side = (s: RawSize): number => Math.max(s.w ?? 0, s.h ?? 0);
  const sorted = [...usable].sort((a, b) => side(a) - side(b));
  const medium = sorted.find(s => s.type === 'm') ?? sorted.find(s => side(s) >= 320) ?? sorted[sorted.length - 1]!;
  return medium.type ?? null;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
};

interface RawMessage {
  id?: number;
  media?: {
    className?: string;
    photo?: { sizes?: unknown };
    document?: { thumbs?: unknown; mimeType?: string };
  } | null;
}

/** On-disk chat name: negative keys use n plus digits, positive keys use u plus digits. */
export function chatDirName(chatKey: string): string {
  return chatKey.startsWith('-') ? `n${chatKey.slice(1)}` : `u${chatKey}`;
}

export class MediaService {
  private readonly tg: Tg;
  private readonly files: SharedFiles;
  private readonly root: string;
  private readonly maxFullBytes: number;
  private readonly quotaBytes: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private writesSinceQuotaCheck = 0;

  constructor(options: MediaServiceOptions) {
    this.tg = options.tg;
    this.files = options.files;
    this.root = join(options.files.root, 'media');
    this.maxFullBytes = options.maxFullBytes ?? DEFAULT_MAX_FULL_BYTES;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.log = options.log ?? createLogger('media');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Downloads media from raw teleproto messages. Previews are the default;
   * full images consume model context and require an explicit request.
   */
  async download(accountId: string, chatKey: string, rawMessages: unknown[], size: MediaSize, options?: TgCallOptions): Promise<MediaResult> {
    const result: MediaResult = { files: [], skipped: [] };
    // Private message IDs are account-specific, so their caches must be separate; one call writes one chat directory.
    const chatDir = join(this.root, accountId, chatDirName(chatKey));
    // Checked once, before the first Telegram download: a refused directory skips every later fetch of this call.
    // SharedFiles does not remember the refusal, so the next call checks again; each write still re-checks the chain.
    let dirChecked: Promise<void> | undefined;

    for (const raw of rawMessages as RawMessage[]) {
      const messageId = raw?.id;
      if (typeof messageId !== 'number') continue;
      const media = normalizeMedia(raw.media);
      if (!media || !media.downloadable) {
        result.skipped.push({ messageId, reason: media ? `${media.kind} cannot be downloaded` : 'no media' });
        continue;
      }

      const isPhoto = media.kind === 'photo';
      let thumb: string | undefined;
      let ext = '.jpg';
      let mime = 'image/jpeg';

      if (size === 'thumb') {
        const sizes = isPhoto ? raw.media?.photo?.sizes : raw.media?.document?.thumbs;
        const type = pickThumbType(sizes);
        if (!type) {
          result.skipped.push({ messageId, reason: 'no preview available' });
          continue;
        }
        thumb = type;
      } else if (!isPhoto) {
        if (media.sizeBytes !== undefined && media.sizeBytes > this.maxFullBytes) {
          result.skipped.push({
            messageId,
            reason: `file is ${Math.round(media.sizeBytes / 1024 / 1024)} MB, over the ${Math.round(this.maxFullBytes / 1024 / 1024)} MB limit; use size=thumb for a preview`,
          });
          continue;
        }
        mime = media.mime ?? 'application/octet-stream';
        // Accept only simple Telegram-supplied extensions; otherwise infer from media type.
        const named = media.fileName ? extname(media.fileName).toLowerCase() : '';
        ext = /^\.[a-z0-9]{1,8}$/.test(named) ? named : (MIME_EXT[mime] ?? '.bin');
      }

      const path = join(chatDir, `${messageId}-${thumb ? 'thumb' : 'full'}${ext}`);
      // Only owned regular files count as cache hits; never follow planted symlinks.
      if ((await this.files.isOwnRegularFile(path)) && lstatSync(path).size > 0) {
        const bytes = lstatSync(path).size;
        if (size === 'full' && bytes > this.maxFullBytes) {
          result.skipped.push({ messageId, reason: this.sizeLimitReason(bytes) });
          continue;
        }
        result.files.push({ messageId, kind: media.kind, size: thumb ? 'thumb' : 'full', path, bytes, mime, cached: true });
        continue;
      }

      try {
        await (dirChecked ??= this.files.ensureDir(chatDir).catch((err: Error) => { result.refused = err.message; throw err; }));
        const buffer = await this.fetch(accountId, raw, thumb, options);
        if (!buffer || buffer.length === 0) {
          result.skipped.push({ messageId, reason: 'Telegram returned an empty file' });
          continue;
        }
        if (size === 'full' && buffer.length > this.maxFullBytes) {
          result.skipped.push({ messageId, reason: this.sizeLimitReason(buffer.length) });
          continue;
        }
        await this.write(path, buffer);
        result.files.push({ messageId, kind: media.kind, size: thumb ? 'thumb' : 'full', path, bytes: buffer.length, mime, cached: false });
      } catch (err) {
        result.skipped.push({ messageId, reason: (err as Error).message });
      }
    }

    return result;
  }

  private sizeLimitReason(bytes: number): string {
    return `file is ${bytes} bytes, over the ${this.maxFullBytes} byte limit; use size=thumb for a preview`;
  }

  private async fetch(accountId: string, raw: RawMessage, thumb: string | undefined, options?: TgCallOptions): Promise<Buffer | null> {
    const attempt = (): Promise<Buffer | null> =>
      this.tg.withClient(
        accountId,
        'downloadMedia',
        async client => {
          const data = await client.downloadMedia(raw as unknown as Api.Message, thumb ? { thumb: thumb as never } : {});
          if (!data) return null;
          return Buffer.isBuffer(data) ? data : Buffer.from(data as string, 'binary');
        },
        // Downloads get a longer deadline; a hang still requires supervisor restart.
        { deadlineMs: 60_000, ...options },
      );

    try {
      return await attempt();
    } catch (err) {
      if (!isDcRedirectError(err)) throw err;
      this.log.warn('file lives in another DC, retrying', { account: accountId, message: raw.id });
      await sleep(2_000);
      return attempt();
    }
  }

  /** Writes files readable by agents running as another OS user. */
  private async write(path: string, buffer: Buffer): Promise<void> {
    await this.files.writeNewFile(path, buffer, 0o644);

    if (++this.writesSinceQuotaCheck >= QUOTA_CHECK_EVERY) {
      this.writesSinceQuotaCheck = 0;
      this.enforceQuota();
    }
  }

  /** Removes oldest files until the directory is below 80% of its quota. */
  enforceQuota(): { removed: number; bytes: number } {
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // Ignore and never follow symlinks; do not delete unrelated files.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const st = lstatSync(full);
          files.push({ path: full, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(this.root);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.quotaBytes) return { removed: 0, bytes: total };

    const target = this.quotaBytes * 0.8;
    let removed = 0;
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= target) break;
      try {
        rmSync(file.path);
        total -= file.size;
        removed++;
      } catch {
        // The file may already have disappeared.
      }
    }
    this.log.info('media quota enforced', { removed, bytes: total, at: this.now() });
    return { removed, bytes: total };
  }
}
