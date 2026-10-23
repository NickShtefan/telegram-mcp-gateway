/** Private service-side application credentials; never an agent-readable configuration command. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readBoundedFile } from '../core/safeFs.js';
import type { ApiCredentials } from './owner.js';
import { SetupError } from './contract.js';

export class ApiCredentialFile {
  constructor(private readonly home: string, private readonly attestPrivateHome: () => Promise<void>,
    private readonly attestWindowsFile?: (path: string) => Promise<void>) {}
  private async text(): Promise<string | null> {
    await this.attestPrivateHome();
    // Windows has no POSIX owner/mode proof: its file ACL attestation is mandatory.
    const windows = this.attestWindowsFile ?? (async () => { throw new SetupError('protection_unverified'); });
    try {
      return (await readBoundedFile(join(this.home, '.env'), { maximum: 65_536, owners: process.getuid ? [process.getuid()] : undefined, modeMask: 0o077,
        attest: process.platform === 'win32' ? windows : undefined, fail: () => new SetupError('invalid_state') })).toString('utf8');
    } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new SetupError('invalid_state'); }
  }
  async read(): Promise<ApiCredentials | null> {
    const text = await this.text(); if (text === null) return null;
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(TG_API_ID|TG_API_HASH)\s*=\s*([A-Za-z0-9]+)\s*$/.exec(line);
      if (match) values.set(match[1]!, match[2]!);
    }
    if (!values.has('TG_API_ID') && !values.has('TG_API_HASH')) return null;
    const apiId = values.get('TG_API_ID') ?? ''; const apiHash = values.get('TG_API_HASH') ?? '';
    if (!/^[1-9]\d{0,11}$/.test(apiId) || !/^[0-9a-f]{32}$/.test(apiHash)) throw new SetupError('invalid_state');
    return { apiId: Number(apiId), apiHash };
  }
  async write(value: ApiCredentials): Promise<void> {
    if (!Number.isSafeInteger(value.apiId) || value.apiId <= 0 || !/^[0-9a-f]{32}$/.test(value.apiHash)) throw new SetupError('invalid_request');
    const prior = await this.text();
    const preserved = (prior ?? '').split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?TG_API_(?:ID|HASH)\s*=/.test(line));
    const text = [...preserved, `TG_API_ID=${value.apiId}`, `TG_API_HASH=${value.apiHash}`, ''].join('\n');
    if (Buffer.byteLength(text) > 65_536) throw new SetupError('invalid_state');
    const temporary = join(this.home, `credentials-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(text); await file.sync(); await file.close();
      if (process.platform === 'win32') {
        if (!this.attestWindowsFile) throw new SetupError('protection_unverified');
        await this.attestWindowsFile(temporary);
      }
      await this.attestPrivateHome(); await rename(temporary, join(this.home, '.env'));
    } finally { await file.close(); await unlink(temporary).catch(() => undefined); }
  }
}
