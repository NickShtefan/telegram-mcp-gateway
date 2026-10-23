/** Bounded canonical USTAR: regular files only, validated completely before writing. */
import { gzipSync, gunzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ApplicationFile { path: string; data: Buffer; executable?: boolean; }
export class ArchiveError extends Error { constructor() { super('unsafe_archive'); } }
const MAX_OUTPUT = 268_435_456;
const MAX_FILE = 33_554_432;
const MAX_FILES = 20_000;
function bad(): never { throw new ArchiveError(); }

function validPath(path: string): void {
  if (!/^[A-Za-z0-9_@.+/-]+$/.test(path) || path.length > 255 || path.startsWith('/') || path.endsWith('/')) bad();
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) bad();
  }
}
function executableAllowed(path: string): boolean { return path === 'dist/native/lease-darwin'; }
function topology(files: ApplicationFile[]): void {
  if (files.length === 0 || files.length > MAX_FILES) bad();
  const seen = new Map<string, 'file' | 'directory'>(); const spelling = new Map<string, string>();
  for (const f of files) {
    validPath(f.path); if (f.data.length > MAX_FILE || (f.executable && !executableAllowed(f.path))) bad();
    const parts = f.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/'); const key = path.toLowerCase(); const kind = i === parts.length ? 'file' : 'directory';
      const prior = seen.get(key);
      if (spelling.has(key) && spelling.get(key) !== path) bad();
      if (prior && (prior !== kind || kind === 'file')) bad();
      seen.set(key, kind); spelling.set(key, path);
    }
  }
}
function octal(header: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8).padStart(width - 1, '0'); if (text.length !== width - 1) bad();
  header.write(text, offset, width - 1, 'ascii');
}
function number(header: Buffer, offset: number, width: number): number {
  const bytes = header.subarray(offset, offset + width); const text = bytes.toString('ascii').replace(/[\0 ]+$/, '');
  if (!/^[0-7]+$/.test(text)) bad(); return Number.parseInt(text, 8);
}
function text(header: Buffer, offset: number, width: number): string {
  const bytes = header.subarray(offset, offset + width); const end = bytes.indexOf(0);
  if (end !== -1 && bytes.subarray(end).some(b => b !== 0)) bad();
  const raw = end === -1 ? bytes : bytes.subarray(0, end);
  if (raw.some(b => b < 32 || b > 126)) bad(); return raw.toString('ascii');
}

export function encodeApplicationArchive(input: ApplicationFile[]): Buffer {
  const files = [...input].sort((a, b) => a.path.localeCompare(b.path, 'en')); topology(files);
  const chunks: Buffer[] = []; let total = 1024;
  for (const f of files) {
    const header = Buffer.alloc(512); let name = f.path; let prefix = '';
    if (name.length > 100) {
      const split = name.lastIndexOf('/', 155); if (split < 1) bad(); prefix = name.slice(0, split); name = name.slice(split + 1);
    }
    if (name.length > 100 || prefix.length > 155) bad();
    header.write(name, 0, 100, 'ascii'); header.write(prefix, 345, 155, 'ascii');
    octal(header, 100, 8, f.executable ? 0o755 : 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
    octal(header, 124, 12, f.data.length); octal(header, 136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    const padding = Buffer.alloc((512 - f.data.length % 512) % 512);
    total += 512 + f.data.length + padding.length; if (total > MAX_OUTPUT) bad();
    chunks.push(header, f.data, padding);
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
}

export function decodeApplicationArchive(compressed: Buffer): ApplicationFile[] {
  if (compressed.length > 134_217_728) bad();
  let bytes: Buffer;
  try { bytes = gunzipSync(compressed, { maxOutputLength: MAX_OUTPUT }); } catch { bad(); }
  if (bytes.length % 512 !== 0 || bytes.length < 1024) bad();
  const files: ApplicationFile[] = []; let offset = 0; let ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) {
      if (offset + 1024 > bytes.length || bytes.subarray(offset).some(b => b !== 0)) bad(); ended = true; break;
    }
    const expected = number(header, 148, 8);
    const checksum = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== expected || header.subarray(257, 263).toString('ascii') !== 'ustar\0' || header.subarray(263, 265).toString('ascii') !== '00') bad();
    const mode = number(header, 100, 8);
    if (header[156] !== 48 || header.subarray(157, 257).some(b => b !== 0) || (mode !== 0o644 && mode !== 0o755)
      || number(header, 108, 8) !== 0 || number(header, 116, 8) !== 0) bad();
    const name = text(header, 0, 100); const prefix = text(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name; const size = number(header, 124, 12);
    if (size > MAX_FILE || files.length >= MAX_FILES || offset + 512 + size > bytes.length) bad();
    const start = offset + 512; const next = start + Math.ceil(size / 512) * 512;
    if (next > bytes.length || bytes.subarray(start + size, next).some(b => b !== 0)) bad();
    if (mode === 0o755 && !executableAllowed(path)) bad();
    files.push({ path, data: bytes.subarray(start, start + size), ...(mode === 0o755 ? { executable: true } : {}) }); offset = next;
  }
  if (!ended) bad(); topology(files); return files;
}

/** Target must already be an attested empty protected directory; no adoption/overwrite. */
export async function extractApplicationArchive(compressed: Buffer, target: string, windowsAttest?: (paths: readonly string[]) => Promise<void>): Promise<number> {
  const files = decodeApplicationArchive(compressed);
  if (process.platform === 'win32') { if (!windowsAttest) bad(); await windowsAttest([target]); }
  const root = await lstat(target);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid()) || (process.platform !== 'win32' && (root.mode & 0o022) !== 0) || (await readdir(target)).length !== 0) bad();
  const windows = process.platform === 'win32';
  const attestationPaths = new Set<string>();
  for (const entry of files) {
    const path = join(target, entry.path);
    const parts = dirname(entry.path).split('/').filter(p => p !== '.'); let directory = target;
    for (const part of parts) {
      directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      const st = await lstat(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (process.platform !== 'win32' && (st.mode & 0o022) !== 0)) bad();
      if (windows) attestationPaths.add(directory);
    }
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
    try {
      if (windows) attestationPaths.add(path);
      else { await file.writeFile(entry.data); await file.sync(); }
    } finally { await file.close(); }
  }
  if (windows) {
    // Empty children inherit the already attested private root ACL. Inspect all
    // unique paths in one bounded process before writing any executable payload.
    await windowsAttest!([...attestationPaths]);
    for (const entry of files) {
      const file = await open(join(target, entry.path), constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const st = await file.stat();
        if (!st.isFile() || st.nlink !== 1 || st.size !== 0) bad();
        await file.writeFile(entry.data); await file.sync();
      } finally { await file.close(); }
    }
  }
  return files.length;
}
