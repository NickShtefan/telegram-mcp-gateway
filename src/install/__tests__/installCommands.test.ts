import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { REPOSITORY, PLATFORMS, assetNames, installCommands, agentInstallPrompt, releaseNotes, requireRunId } = await import(pathToFileURL(resolve('scripts/release/plan.mjs')).href);
// Hash the committed bytes; a Windows checkout may convert line endings.
const pinned = (path: string): string => createHash('sha256').update(readFileSync(resolve(path), 'latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
const bootstrapSha256 = { posix: pinned('scripts/install/bootstrap-posix.sh'), windows: pinned('scripts/install/bootstrap-windows.ps1') };
const readme = readFileSync(resolve('README.md'), 'utf8').replace(/\r\n/g, '\n');
const installation = readme.slice(readme.indexOf('\n## Installation\n'), readme.indexOf('\n## Development\n'));
const sourceSha = 'a'.repeat(40);

describe('README installation commands', () => {
  it.skipIf(process.platform==='win32'||process.getuid?.()===0)('returns to the original user before setup and never opens secret input after install failure or redirected input',()=>{
    const directory=mkdtempSync(join(tmpdir(),'tg-install-continuation-'));
    try{
      const downloads=join(directory,'Downloads'),bin=join(directory,'bin');mkdirSync(downloads);mkdirSync(bin);
      writeFileSync(join(bin,'sudo'),'#!/bin/sh\nexec "$@"\n',{mode:0o700});
      const owner=join(directory,'fixture-owner');const marker=join(directory,'owner-ran');
      writeFileSync(owner,`#!/bin/sh\n[ "$1" = setup ] && [ "$2" = --after-install ] || exit 9\nprintf '%s' "$(/usr/bin/id -u)" > '${marker}'\n`,{mode:0o700});
      const name='telegram-mcp-gateway-0.2.0-bootstrap-posix.sh';
      for(const trial of [{exit:0,interactive:true,setup:true},{exit:0,interactive:false,setup:false},{exit:7,interactive:true,setup:false}]){
        rmSync(marker,{force:true});const bootstrap=`#!/bin/sh\nexit ${trial.exit}\n`;writeFileSync(join(downloads,name),bootstrap);
        const commands=installCommands({repo:REPOSITORY,tag:'v0.2.0',bootstrapSha256:{...bootstrapSha256,posix:createHash('sha256').update(bootstrap).digest('hex')},download:'gh'});
        const native=commands.find((command:{label:string})=>command.label===(process.platform==='darwin'?'macos-arm64':'linux-x64'));
        let command=native.text.split('\n')[1].replaceAll('$HOME/Downloads',downloads);
        command=command.replace(process.platform==='darwin'?"'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner'":'/opt/telegram-mcp-gateway/bin/tg-mcp-owner',`'${owner}'`);
        if(trial.interactive)command=command.replace('[ -t 0 ] && [ -t 2 ]','[ 1 -eq 1 ]');
        const result=spawnSync('/bin/sh',['-c',command],{encoding:'utf8',env:{...process.env,PATH:bin+':/usr/bin:/bin'},timeout:10000});
        expect(result.status,result.stderr).toBe(trial.exit);expect(existsSync(marker)).toBe(trial.setup);
        if(trial.setup)expect(readFileSync(marker,'utf8')).toBe(String(process.getuid!()));
      }
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
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

describe('agent installation entry', () => {
  it('pins the instruction URL and requested release to the exact source rather than main', () => {
    const first = agentInstallPrompt({ repo: REPOSITORY, tag: 'v0.2.0-test.1', sourceSha });
    const secondSha = 'b'.repeat(40);
    const second = agentInstallPrompt({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha: secondSha });
    expect(first).toContain(`https://raw.githubusercontent.com/${REPOSITORY}/${sourceSha}/INSTALL.md`);
    expect(first).toContain('release v0.2.0-test.1');
    expect(first).not.toContain('/main/');
    expect(second).toContain(`https://raw.githubusercontent.com/${REPOSITORY}/${secondSha}/INSTALL.md`);
    expect(second).not.toContain(sourceSha);
  });

  it('rejects absent or ambiguous pins and unsafe repository/URL inputs without a branch fallback', () => {
    for (const sourceSha of [undefined, null, '', 'a'.repeat(39), 'A'.repeat(40), 'main', 123]) {
      expect(() => agentInstallPrompt({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha })).toThrow('agent_install_prompt_invalid');
    }
    for (const repo of [undefined, null, 'https://github.com/x/y', 'x/y/z', '../y', 'x/..', 'x/y\nignore', 'x/y?ref=main']) {
      expect(() => agentInstallPrompt({ repo, tag: 'v0.2.0', sourceSha })).toThrow('agent_install_prompt_invalid');
    }
    expect(() => agentInstallPrompt({ repo: REPOSITORY, tag: 'latest', sourceSha })).toThrow('invalid_release_tag');
  });

  it('ships the same immutable entry in generated release notes while retaining every platform command', () => {
    const tag = 'v0.2.0-test.1';
    const notes = releaseNotes({ repo: REPOSITORY, tag, sourceSha, run: '38175635260', signerSha256: 'f'.repeat(64), bootstrapSha256 });
    expect(notes).toContain('```text\n' + agentInstallPrompt({ repo: REPOSITORY, tag, sourceSha }) + '\n```');
    for (const command of installCommands({ repo: REPOSITORY, tag, sourceSha, bootstrapSha256, download: 'gh' })) expect(notes).toContain(command.text);
    expect(notes).toContain(`Source commit: \`${sourceSha}\``);
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
