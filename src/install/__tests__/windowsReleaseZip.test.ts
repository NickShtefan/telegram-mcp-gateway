import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeReleaseZip, SIGNED_FILES } from '../releasePackage.js';

const { runtimeEntry } = await import(pathToFileURL(resolve('scripts/install/runtime-entry.mjs')).href);
const helper = resolve('scripts/checks/windows-release-zip.mjs');
const names = SIGNED_FILES.map(name => name === 'node' ? 'node.exe' : name);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function payload(): { root: string; directory: string; files: Map<string, Buffer> } {
  const root = mkdtempSync(join(tmpdir(), 'tg-windows-zip-')); roots.push(root);
  const directory = join(root, 'payload'); mkdirSync(directory);
  const files = new Map(names.map((name, i) => [name, Buffer.alloc(name === 'manifest.sig' ? 384 : 3, i + 1)]));
  for (const [name, data] of files) writeFileSync(join(directory, name), data);
  return { root, directory, files };
}
const run = (...args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', timeout: 20000 });

describe('Windows release check fixture encoder', () => {
  it('writes exactly the bytes of the release encoder, readable by the production entry reader', () => {
    const { root, directory, files } = payload(); const output = join(root, 'release.zip');
    const result = run(directory, output);
    expect(result.status).toBe(0);
    expect(readFileSync(output)).toEqual(encodeReleaseZip(files));
    for (const [name, data] of files) expect(runtimeEntry(output, name, 134217728, true)).toEqual(data);
  });
  it('rejects missing, extra or non-regular files and never overwrites an archive', () => {
    const { root, directory } = payload(); const output = join(root, 'release.zip');
    rmSync(join(directory, 'NODE_LICENSE'));
    expect(run(directory, output).status).not.toBe(0); expect(existsSync(output)).toBe(false);
    mkdirSync(join(directory, 'NODE_LICENSE'));
    expect(run(directory, output).status).not.toBe(0); expect(existsSync(output)).toBe(false);
    rmSync(join(directory, 'NODE_LICENSE'), { recursive: true }); writeFileSync(join(directory, 'NODE_LICENSE'), 'x'); writeFileSync(join(directory, 'extra'), 'x');
    expect(run(directory, output).status).not.toBe(0); expect(existsSync(output)).toBe(false);
    rmSync(join(directory, 'extra')); writeFileSync(output, 'existing');
    expect(run(directory, output).status).not.toBe(0); expect(readFileSync(output, 'utf8')).toBe('existing');
    expect(run(directory).status).not.toBe(0);
  });
});
