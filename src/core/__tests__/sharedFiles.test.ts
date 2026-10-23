import { execFileSync } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SharedFiles } from '../safeFs.js';
import { attestWindowsDirectories, type DirectoryAttestor } from '../windowsAcl.js';

const windows = process.platform === 'win32';
let root: string;
let attest: Mock<DirectoryAttestor>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-shared-'));
  attest = vi.fn<DirectoryAttestor>(async () => null);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// The Windows rules run on every OS with a fake ACL attestation; the real one runs below on Windows only.
describe('shared files under the Windows rules', () => {
  const files = (): SharedFiles => new SharedFiles(root, { attest, windows: true });

  it('creates files after one batched attestation and reads them back', async () => {
    const shared = files(); const path = join(root, 'exports', 'user_a', 'rows.jsonl');
    await shared.writeNewFile(path, Buffer.from('synthetic row'));
    expect(attest.mock.calls).toEqual([[[root, join(root, 'exports'), join(root, 'exports', 'user_a')]]]);
    expect((await shared.readOwnFile(path, 64))!.toString()).toBe('synthetic row');
    expect(await shared.readOwnFile(path, 12)).toBeNull();
    // Replacing an own file needs no new attestation.
    closeSync(await shared.openNewFile(path));
    expect(readFileSync(path).length).toBe(0);
    expect(attest).toHaveBeenCalledOnce();
  });

  it('never reads or reuses a hard link, a file outside the root or one in an unattested directory', async () => {
    const shared = files(); const path = join(root, 'media', 'a.jpg');
    await shared.writeNewFile(path, Buffer.from('synthetic image'));
    const outside = `${root}-outside.jpg`;
    writeFileSync(outside, 'synthetic outside');
    try { expect(await shared.readOwnFile(outside, 64)).toBeNull(); } finally { rmSync(outside, { force: true }); }
    linkSync(path, join(root, 'media', 'b.jpg'));
    expect(await shared.readOwnFile(path, 64)).toBeNull();
    expect(await shared.isOwnRegularFile(path)).toBe(false);
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other', 'c.jpg'), 'synthetic');
    attest.mockResolvedValue({ path: join(root, 'other'), why: 'is writable by other users' });
    expect(await shared.isOwnRegularFile(join(root, 'other', 'c.jpg'))).toBe(false);
    expect(await shared.readOwnFile(join(root, 'other', 'c.jpg'), 64)).toBeNull();
  });

  it('rejects an existing foreign entry and a link where a file is created', async () => {
    const shared = files();
    mkdirSync(join(root, 'media', 'sub'), { recursive: true });
    await expect(shared.openNewFile(join(root, 'media', 'sub'))).rejects.toThrow('exists and is not a file of the gateway');
    symlinkSync(join(root, 'media', 'sub'), join(root, 'media', 'link'), 'junction');
    await expect(shared.ensureDir(join(root, 'media', 'link'))).rejects.toThrow('link is a symbolic link');
  });
});

/** Explicit protected ACL like the provisioned files directory: administrators, SYSTEM and this identity full, Users read. */
function protect(path: string): void {
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);foreach($sid in @('S-1-5-32-544','S-1-5-18',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:TG_TEST_TARGET -AclObject $acl"],
  { env: { SystemRoot: 'C:\\Windows', TG_TEST_TARGET: path }, stdio: 'ignore', timeout: 60_000 });
}
function grantUsersWrite(path: string): void {
  execFileSync('C:\\Windows\\System32\\icacls.exe', [path, '/grant', '*S-1-5-32-545:(W)'], { stdio: 'ignore', timeout: 60_000 });
}

describe.skipIf(!windows)('Windows ACL attestation of the files directory', () => {
  it('accepts a protected tree, including non-ASCII names, in one helper process', { timeout: 120_000 }, async () => {
    protect(root);
    const named = join(root, `files-${String.fromCharCode(233, 0x444)}`); mkdirSync(named);
    expect(await attestWindowsDirectories([root, named])).toBeNull();
  });

  it('names the directory that other users can write, a junction or a missing path', { timeout: 120_000 }, async () => {
    protect(root);
    const open = join(root, 'open'); mkdirSync(open); grantUsersWrite(open);
    expect(await attestWindowsDirectories([root, open])).toEqual({ path: open, why: 'is writable by other users' });
    const target = join(root, 'target'); mkdirSync(target);
    const junction = join(root, 'junction'); symlinkSync(target, junction, 'junction');
    expect(await attestWindowsDirectories([root, junction])).toEqual({ path: junction, why: 'is a reparse point (symbolic link or junction)' });
    expect(await attestWindowsDirectories([join(root, 'absent')])).toEqual({ path: join(root, 'absent'), why: 'is missing' });
  });

  it('writes and reads through the real attestation and refuses an unsafe directory', { timeout: 120_000 }, async () => {
    protect(root);
    const shared = new SharedFiles(root); const path = join(root, 'media', 'agent', 'u42', '7-thumb.jpg');
    await shared.writeNewFile(path, Buffer.from('synthetic image'));
    expect((await shared.readOwnFile(path, 64))!.toString()).toBe('synthetic image');
    const open = join(root, 'exports'); mkdirSync(open); grantUsersWrite(open);
    await expect(shared.openNewFile(join(open, 'user_a', 'rows.jsonl'))).rejects.toThrow(`${open} is writable by other users`);
  });
});
