import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Exercise the production transaction block with synthetic package managers.
// No system repository, package, service or network change is performed.
describe.skipIf(process.platform === 'win32')('isolated official prerequisite transactions', () => {
  it.each(['ubuntu','arch'])('ignores configured third-party sources for %s and applies only after consent', manager => {
    const directory=mkdtempSync(join(tmpdir(),'tg-prereq-test-'));
    try {
      const log=join(directory,'log');const consent=join(directory,'consent');const command=join(directory,'manager');
      writeFileSync(command,`#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> '${log}'\nif [ -n "\u0024{APT_CONFIG:-}" ]; then /bin/cat "$APT_CONFIG" >> '${log}'; sources=$(/usr/bin/awk '$1=="Dir::Etc::sourcelist" {gsub(/[\";]/,"",$2);print $2}' "$APT_CONFIG");/bin/cat "$sources" >> '${log}';else /bin/cat "$2" >> '${log}';fi\n`);
      chmodSync(command,0o700);
      const source=readFileSync(resolve('scripts/install/bootstrap-posix.sh'),'utf8');
      let block=source.slice(source.indexOf('  # Isolate package resolution'),source.indexOf('  [ -x /usr/bin/openssl ] &&',source.indexOf('  # Isolate package resolution')));
      block=block.replaceAll('/usr/bin/apt-get',command).replaceAll('/usr/bin/pacman',command).replaceAll('</dev/tty',`<'${consent}'`).replaceAll('>/dev/tty','>/dev/null');
      // The OS keyring presence is an injected fixture dependency, never a real key read.
      block=block.replace('[ -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ]','true');
      const script=join(directory,'fixture.sh');writeFileSync(script,`#!/bin/sh\nset -eu\nfail(){ exit 1; }\nmanager=${manager}\narch=x64\nmissing=' openssl'\n${block}`);
      writeFileSync(consent,'CANCEL\n');
      const rejected=spawnSync('/bin/sh',[script],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',APT_CONFIG:'/third-party/evil.conf'}});
      expect(rejected.status).toBe(1);
      expect(readFileSync(log,'utf8')).not.toMatch(/^(?:--no-upgrade|--config .* -S --needed)/m);
      writeFileSync(log,'');writeFileSync(consent,'INSTALL\n');
      const accepted=spawnSync('/bin/sh',[script],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',APT_CONFIG:'/third-party/evil.conf'}});
      expect(accepted.status,accepted.stderr).toBe(0);
      const recorded=readFileSync(log,'utf8');expect(recorded).not.toContain('third-party');
      if(manager==='ubuntu'){
        expect(recorded).toContain('Dir::Etc::main "/dev/null"');
        expect(recorded).toContain('https://archive.ubuntu.com/ubuntu noble main universe');
        expect(recorded).toContain('https://security.ubuntu.com/ubuntu noble-security main universe');
        expect(recorded).toContain('signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg');
        expect(recorded).toContain('--no-upgrade --no-install-recommends install openssl');
      } else {
        expect(recorded).toContain('SigLevel = Required DatabaseOptional');expect(recorded).not.toContain('Include');
        expect(recorded).toContain('https://geo.mirror.pkgbuild.com/core/os/x86_64');
        expect(recorded).toMatch(/-S --needed openssl/);expect(recorded).not.toMatch(/-S[yYu]/);
      }
    } finally {rmSync(directory,{recursive:true,force:true})}
  });
});
