import { Api } from 'teleproto';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { PublishedPost } from './linkEdit.js';

export const MEDIA_EDIT = 'replace_media';
const filename = z.string().min(1).max(180).regex(/^[^<>:"/\\|?*\p{C}]+$/u)
  .refine(s => s !== '.' && s !== '..' && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s));
const optionsSchema = z.object({
  spoiler: z.boolean().optional(),
  cover: z.string().min(1).optional(),
  timestamp: z.number().int().nonnegative().max(2147483647).nullable().optional(),
  upload_as: z.enum(['photo','video','document']).optional(),
  filename: filename.optional(),
  width: z.number().int().positive().max(16384).optional(),
  height: z.number().int().positive().max(16384).optional(),
  duration: z.number().positive().max(86400).optional(),
}).strict();

export type MediaOptions = z.infer<typeof optionsSchema>;
export type MediaKind = 'photo' | 'video' | 'document';
export interface MediaInfo { kind: MediaKind; id: string; filename?: string; mime?: string; bytes?: string; duration?: number;
  spoiler: boolean; cover: string | null; timestamp: number | null }
export type Asset = { info: MediaInfo; object: Api.Photo | Api.Document; cover?: Api.Photo; videoFlag?: boolean };

export function invalid(reason: string): never { throw new GatewayError('INVALID_ARGUMENT', reason); }
export function conflict(reason: string): never { throw new GatewayError('EDIT_CONFLICT', reason); }
export function safeName(value: string) { return filename.safeParse(value).success; }
export function parseMediaOptions(raw?: string): MediaOptions {
  try { return optionsSchema.parse(JSON.parse(raw ?? '{}')); }
  catch { return invalid('Invalid media_options_json. See the media editing guide for supported fields.'); }
}

export function assetOf(m: Api.TypeMessageMedia | undefined): Asset {
  if (m?.className === 'MessageMediaPhoto' && m.photo?.className === 'Photo' && !m.livePhoto && !m.video && m.ttlSeconds == null) {
    return { object: m.photo, info: { kind: 'photo', id: String(m.photo.id), spoiler: !!m.spoiler, cover: null, timestamp: null } };
  }
  if (m?.className !== 'MessageMediaDocument' || m.document?.className !== 'Document' || m.ttlSeconds != null ||
      m.round || m.voice || m.nopremium || m.altDocuments?.length || (m.videoCover && m.videoCover.className !== 'Photo')) {
    return invalid('Choose an ordinary photo, video or document.');
  }
  const doc = m.document;
  const video = doc.attributes.find(a => a.className === 'DocumentAttributeVideo');
  if (video?.roundMessage || doc.attributes.some(a => !['DocumentAttributeFilename','DocumentAttributeVideo','DocumentAttributeImageSize'].includes(a.className))) {
    return invalid('Audio, animations, stickers and special documents are unsupported.');
  }
  if (m.video && !video) return invalid('Telegram did not return the video attributes.');
  const cover = m.videoCover?.className === 'Photo' ? m.videoCover : undefined;
  const name = doc.attributes.find(a => a.className === 'DocumentAttributeFilename')?.fileName;
  return { object: doc, cover, videoFlag: !!m.video, info: { kind: video ? 'video' : 'document', id: String(doc.id), bytes: String(doc.size), mime: doc.mimeType,
    ...(name !== undefined ? { filename: name } : {}), ...(video ? { duration: video.duration } : {}),
    spoiler: !!m.spoiler, cover: cover ? String(cover.id) : null, timestamp: m.videoTimestamp ?? null } };
}

export function eligible(post: PublishedPost) {
  if (post.replyMarkup || post.factcheck || post.replyTo?.replyMedia || post.richMessage || post.viaBotId ||
      post.suggestedPost || post.scheduleRepeatPeriod || post.ttlPeriod) invalid('This special post cannot be safely edited.');
  return assetOf(post.media);
}

export function settings(before: MediaInfo, next: MediaKind, options: MediaOptions, cover?: Api.Photo, duration?: number) {
  const spoiler = options.spoiler ?? before.spoiler;
  const coverId = options.cover === 'clear' ? null : cover ? String(cover.id) : before.cover;
  const timestamp = options.timestamp === undefined ? before.timestamp : options.timestamp;
  if (next === 'document' && spoiler) invalid('Only photos and videos support a media spoiler. Clear it explicitly.');
  if (next !== 'video' && (coverId !== null || timestamp !== null)) invalid('Clear the video cover and timestamp when changing media type.');
  if (timestamp !== null && duration !== undefined && timestamp > duration) invalid('The timestamp exceeds the video duration.');
  return { spoiler, cover: coverId, timestamp };
}

export function inputMedia(asset: Asset, attributes: ReturnType<typeof settings>, cover?: Api.Photo) {
  const object = asset.object;
  const ref = { id: object.id, accessHash: object.accessHash, fileReference: object.fileReference };
  if (object.className === 'Photo') return new Api.InputMediaPhoto({ id: new Api.InputPhoto(ref), spoiler: attributes.spoiler || undefined });
  if (attributes.cover !== null && String(cover?.id) !== attributes.cover) conflict('The approved video cover is no longer available.');
  return new Api.InputMediaDocument({ id: new Api.InputDocument(ref), spoiler: attributes.spoiler || undefined,
    videoCover: attributes.cover && cover ? new Api.InputPhoto({ id: cover.id, accessHash: cover.accessHash, fileReference: cover.fileReference }) : undefined,
    videoTimestamp: attributes.timestamp ?? undefined });
}
