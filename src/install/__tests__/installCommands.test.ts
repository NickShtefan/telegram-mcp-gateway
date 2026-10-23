import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { REPOSITORY, PLATFORMS, assetNames, installCommands, releaseNotes, requireRunId } = await import(pathToFileURL(resolve('scripts/release/plan.mjs')).href);
// Hash the committed bytes; a Windows checkout may convert line endings.
const pinned = (path: string): string => createHash('sha256').update(readFileSync(resolve(path), 'latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
const bootstrapSha256 = { posix: pinned('scripts/install/bootstrap-posix.sh'), windows: pinned('scripts/install/bootstrap-windows.ps1') };
const readme = readFileSync(resolve('README.md'), 'utf8').replace(/\r\n/g, '\n');
const installation = readme.slice(readme.indexOf('\n## Installation\n'), readme.indexOf('\n## Development\n'));
const sourceSha = 'a'.repeat(40);

describe('README installation commands', () => {
  it('match the generated commands and the current bootstrap bytes for every platform', () => {
    const expected = installCommands({ repo: REPOSITORY, tag: 'v0.2.0', bootstrapSha256, download: 'gh' });
    expect(expected.map((c: { label: string }) => c.label)).toEqual(PLATFORMS.map((p: { label: string }) => p.label));
    for (const command of expected) {
      const heading = installation.indexOf(`\n### ${command.title}\n`);
      expect(heading, command.title).toBeGreaterThan(0);
      const block = installation.slice(heading).match(/```(sh|powershell)\n([\s\S]*?)\n```/);
      expect(block?.[1]).toBe(command.language);
      // On mismatch, refresh README from installCommands(): a changed bootstrap changes one hash line per block.
      expect(block?.[2], command.title).toBe(command.text);
    }
    expect(installation.match(/```(?:sh|powershell)\n/g)).toHaveLength(PLATFORMS.length);
    expect(installation.split(bootstrapSha256.windows)).toHaveLength(2);
  });
  it('links only to the current repository and never asks for a source SHA', () => {
    // Links and download commands name the same public development repository.
    const repositories = [...readme.matchAll(/\bNickShtefan\/([-A-Za-z0-9_]+(?:\.[-A-Za-z0-9_]+)*)/g)].map(m => `NickShtefan/${m[1]}`);
    expect(installation).toContain(`https://github.com/${REPOSITORY}/releases`);
    expect(repositories.length).toBeGreaterThan(0);
    expect(new Set(repositories)).toEqual(new Set([REPOSITORY]));
    expect(installation).not.toMatch(/\b[0-9a-f]{40}\b/);
  });
});

describe('release names and pinned commands', () => {
  it('puts the release name into every asset so test drafts cannot pass for the final release', () => {
    const final = assetNames('v0.2.0'), test = assetNames('v0.2.0-test.1');
    const all = (n: ReturnType<typeof assetNames>) => [...PLATFORMS.map((p: { label: string }) => n.archive(p.label)), n.posixBootstrap, n.windowsBootstrap, n.checksums];
    expect(all(final)).toContain('telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz');
    expect(all(test)).toContain('telegram-mcp-gateway-0.2.0-test.1-windows-x64.zip');
    for (const name of all(test)) { expect(name.startsWith('telegram-mcp-gateway-0.2.0-test.1-')).toBe(true); expect(all(final)).not.toContain(name); }
    for (const tag of ['0.2.0', 'v0.2.1', 'v0.2.0-', 'v0.2.0-test..1', 'v0.2.0-test/1', '--publish']) expect(() => assetNames(tag)).toThrow('invalid_release_tag');
  });
  it('pins the exact source by one added argument and changes only the download for public releases', () => {
    const base = installCommands({ repo: REPOSITORY, tag: 'v0.2.0', bootstrapSha256, download: 'gh' });
    const exact = installCommands({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha, bootstrapSha256, download: 'gh' });
    const publicRelease = installCommands({ repo: REPOSITORY, tag: 'v0.2.0', bootstrapSha256, download: 'public' });
    base.forEach((command: { text: string; language: string }, i: number) => {
      const added = command.language === 'sh' ? ` ${sourceSha}` : ` -SourceSha '${sourceSha}'`;
      expect(exact[i].text.split(added)).toHaveLength(2);
      expect(exact[i].text.replace(added, '')).toBe(command.text);
      const [download, ...rest] = publicRelease[i].text.split('\n');
      expect(rest).toEqual(command.text.split('\n').slice(1));
      expect(download).toContain(`https://github.com/${REPOSITORY}/releases/download/v0.2.0/`);
      expect(download).not.toContain('gh ');
    });
    expect(() => installCommands({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha: 'b'.repeat(39), bootstrapSha256, download: 'gh' })).toThrow();
    expect(() => installCommands({ repo: REPOSITORY, tag: 'v0.2.0', bootstrapSha256, download: 'browser' })).toThrow();
  });
  it('writes the pinned commands into release notes and marks test drafts', () => {
    const notes = releaseNotes({ repo: REPOSITORY, tag: 'v0.2.0-test.1', sourceSha, run: '38175635260', signerSha256: 'f'.repeat(64), bootstrapSha256 });
    expect(notes).toContain('# Test draft v0.2.0-test.1');
    for (const command of installCommands({ repo: REPOSITORY, tag: 'v0.2.0-test.1', sourceSha, bootstrapSha256, download: 'gh' })) expect(notes).toContain(command.text);
    expect(releaseNotes({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha, run: '38175635260', signerSha256: 'f'.repeat(64), bootstrapSha256 })).not.toContain('Test draft');
  });
  it('accepts a CI run ID and rejects a short run number', () => {
    expect(requireRunId('38175635260')).toBe('38175635260');
    for (const run of ['25', '#25', '0038175635', '38175635260/attempts/2', undefined]) expect(() => requireRunId(run)).toThrow('ci_run_id_required');
  });
});
