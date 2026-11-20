import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { attestPrivateUpload } from '../core/windowsAcl.js';
import { join } from 'node:path';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { readBoundedFile } from '../core/safeFs.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import { assetOf, conflict, invalid, safeName, type MediaOptions, type MediaKind } from './mediaPayload.js';

const maximum = 32 * 1024 * 1024;
const partSize = 512 * 1024;
export interface UploadHandle { name: string; filename: string; kind: MediaKind; sha256: string; bytes: number; mime: string;
  width?: number; height?: number; duration?: number }

export async function openUpload(home: string, user: string, account: string, name: string, opt: MediaOptions) {
  if (!safeName(name) || ![user,account].every(id => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id))) invalid('Use a single filename in the account upload inbox.');
  const inbox = join(home, 'uploads');
  const profile = join(inbox,user);
  const dir = join(profile,account);
  const directories = [home,inbox,profile,dir];
  const check = async () => {
    for (const path of directories) {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && (st.uid !== process.getuid() ||
          (st.mode & (path === home ? 0o022 : 0o077)) !== 0))) invalid('The upload inbox is not private.');
    }
    if (process.platform === 'win32' && await attestPrivateUpload([...directories,join(dir,name)])) invalid('The upload ACL is not private.');
  };
  let bytes: Buffer;
  try {
    await check();
    bytes = await readBoundedFile(join(dir,name), { maximum, owners: process.getuid ? [process.getuid()] : undefined, modeMask: 0o077, attest: check,
      fail: () => new GatewayError('INVALID_ARGUMENT','The upload must be a trusted regular file of at most 32 MiB.') });
  } catch (err) {
    if (isGatewayError(err)) throw err;
    return invalid('The account upload is missing or unreadable.');
  }
  if (!bytes.length) invalid('The upload is empty.');
  const kind = opt.upload_as ?? 'document';
  const jpeg = bytes.subarray(0,3).equals(Buffer.from([255,216,255]));
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (kind === 'photo' && !jpeg && !png) invalid('Photo uploads require JPEG or PNG content.');
  if (kind === 'video' && (bytes.toString('ascii',4,8) !== 'ftyp' || !opt.width || !opt.height || !opt.duration)) invalid('Video uploads require MP4 content, width, height and duration.');
  if (kind !== 'video' && [opt.width,opt.height,opt.duration].some(x => x !== undefined)) invalid('Only a video upload accepts dimensions and duration.');
  const handle: UploadHandle = { name, filename: opt.filename ?? name, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: kind === 'video' ? 'video/mp4' : kind === 'photo' ? (jpeg ? 'image/jpeg' : 'image/png') : 'application/octet-stream',
    ...(kind === 'video' ? { width:opt.width, height:opt.height, duration:opt.duration } : {}) };
  if (kind === 'photo' && opt.filename !== undefined) invalid('Telegram photos do not retain a filename. Use a document to keep it.');
  return { handle, bytes };
}

export async function uploadAsset(tg: Tg, account: string, peer: Api.TypeInputPeer, handle: UploadHandle, data: Buffer, options: TgCallOptions) {
  const fileId = bigInt(randomBytes(8).readBigInt64LE().toString());
  const big = data.length > 10 * 1024 * 1024;
  const parts = Math.ceil(data.length / partSize);
  for (let part = 0; part < parts; part++) {
    const args = { fileId, filePart: part, bytes: data.subarray(part*partSize,(part+1)*partSize) };
    const ok = await tg.invoke(account, big ? new Api.upload.SaveBigFilePart({ ...args, fileTotalParts: parts }) : new Api.upload.SaveFilePart(args), options);
    if (!ok) throw new GatewayError('UNAVAILABLE','Telegram did not accept the upload part.');
  }
  const args = { id:fileId, parts, name:handle.filename };
  const file = big ? new Api.InputFileBig(args) : new Api.InputFile({ ...args, md5Checksum:createHash('md5').update(data).digest('hex') });
  const attrs: Api.TypeDocumentAttribute[] = [new Api.DocumentAttributeFilename({fileName:handle.filename})];
  if (handle.kind === 'video') attrs.push(new Api.DocumentAttributeVideo({ w:handle.width!, h:handle.height!, duration:handle.duration! }));
  const media = handle.kind === 'photo' ? new Api.InputMediaUploadedPhoto({file}) : new Api.InputMediaUploadedDocument({
    file, mimeType:handle.mime, attributes:attrs, forceFile:handle.kind === 'document' || undefined });
  const asset = assetOf(await tg.invoke(account, new Api.messages.UploadMedia({peer,media}), options));
  if (asset.info.kind !== handle.kind || (handle.kind !== 'photo' && (asset.info.filename !== handle.filename ||
      asset.info.bytes !== String(handle.bytes) || asset.info.mime !== handle.mime))) conflict('Telegram returned different uploaded media.');
  if (handle.kind === 'video' && asset.object.className === 'Document') {
    const v = asset.object.attributes.find(a => a.className === 'DocumentAttributeVideo');
    if (!v || v.w !== handle.width || v.h !== handle.height || v.duration !== handle.duration) conflict('Telegram returned different video attributes.');
  }
  return asset;
}
