import { mkdtemp, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureClient, readSelectedClientTokens, type OwnerProfile } from '../clientFile.js';
const roots: string[] = []; const token = 'synthetic_credential_012345678901234567890';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<OwnerProfile> {
  const home = await mkdtemp(join(tmpdir(), 'tg-client-')); roots.push(home);
  return { home, authorize: async () => undefined, attest: async (path, privateFile) => {
    const st = await lstat(path); if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error('unsafe');
    if (privateFile && process.platform !== 'win32' && (st.mode & 0o077)) throw new Error('public');
  } };
}
describe('unelevated client profile handoff', () => {
  it('writes privately and preserves unrelated JSON settings without returning token text', async () => {
    const owner = await fixture(); await writeFile(join(owner.home, '.claude.json'), '{"model":"owner-model"}', { mode: 0o600 });
    const result = await configureClient(owner, 'claude', 7777, token);
    expect(JSON.stringify(result)).not.toContain(token); expect(result.tool_loading_verified).toBe(false);
    expect(JSON.parse(await readFile(join(owner.home, '.claude.json'), 'utf8')).model).toBe('owner-model');
    expect(await configureClient(owner, 'claude', 7777, token)).toEqual(result);
  });
  it('rejects unauthorized profile access before creating paths', async () => {
    const owner = await fixture(); owner.authorize = async () => { throw new Error('not original owner'); };
    await expect(configureClient(owner, 'codex', 7777, token)).rejects.toThrow('invalid_state');
    await expect(lstat(join(owner.home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves a concurrently changed client file instead of overwriting it', async () => {
    const owner = await fixture(); const path = join(owner.home, '.claude.json'); await writeFile(path, '{"model":"first"}');
    const attest = owner.attest; owner.attest = async (target, privateFile) => {
      await attest(target, privateFile);
      if (target.endsWith('.next')) await writeFile(path, '{"model":"concurrent"}');
    };
    await expect(configureClient(owner, 'claude', 7777, token)).rejects.toThrow('invalid_state');
    expect(await readFile(path, 'utf8')).toBe('{"model":"concurrent"}');
  });
  it.skipIf(process.platform === 'win32')('preserves a redirected profile path and never touches its target', async () => {
    const owner = await fixture(); const target = join(owner.home, 'other'); await writeFile(target, '{"model":"other"}');
    await symlink(target, join(owner.home, '.claude.json'));
    await expect(configureClient(owner, 'claude', 7777, token)).rejects.toThrow('invalid_state');
    expect(await readFile(target, 'utf8')).toBe('{"model":"other"}');
  });
});

describe('credential bytes are never written before private-file proof', () => {
  it('rejects unsafe temporary permissions before writing a bearer', async () => {
    const owner=await fixture(); const attest=owner.attest;
    owner.attest=async (path,privateFile)=>{if(path.endsWith('.next')&&privateFile){expect((await readFile(path)).length).toBe(0);throw new Error('public temporary');}await attest(path,privateFile);};
    await expect(configureClient(owner,'claude',7777,token)).rejects.toThrow('invalid_state');
    await expect(lstat(join(owner.home,'.claude.json'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('preserves invalid UTF-8 instead of normalizing unrelated bytes', async () => {
    const owner=await fixture();const path=join(owner.home,'.claude.json');const bytes=Buffer.from([123,34,120,34,58,34,255,34,125]);
    await writeFile(path,bytes);await expect(configureClient(owner,'claude',7777,token)).rejects.toThrow('invalid_state');expect(await readFile(path)).toEqual(bytes);
  });
});

describe('selected profile candidates',()=>{
  it('collects distinct own-gateway credentials without choosing their user in the client process',async()=>{
    const owner=await fixture();const other='second_credential_012345678901234567890';
    await configureClient(owner,'claude',7777,token);await configureClient(owner,'hermes',7777,other);
    expect(await readSelectedClientTokens(owner,['claude','hermes'],7777)).toEqual([token,other]);
    expect(await readSelectedClientTokens(owner,['hermes','claude'],7777)).toEqual([other,token]);
  });
});
