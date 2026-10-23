/** Client-profile writes run only as the original, unelevated owner. No privileged user-tree writes. */
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFile } from '../core/safeFs.js';
import { patchClientConfig, clientRelativePath, configuredGatewayToken, ClientEntryConflict, type ClientKind } from './clientConfig.js';
import { SetupError } from './contract.js';

export interface OwnerProfile {
  home: string;
  /** Attest actual original OS user, unelevated process and selected effective default profile. */
  authorize(): Promise<void>;
  /** Reject reparse/link ancestors and foreign mutation; private files deny foreign read. */
  attest(path: string, privateFile: boolean): Promise<void>;
  /** Windows: restrict the just-created empty temporary file before writing any bearer bytes. */
  preparePrivateFile?(path: string): Promise<void>;
}
const limit = 1048576;
async function readExisting(path: string, owner: OwnerProfile): Promise<{ bytes: Buffer; inode: number; device: number } | null> {
  let inode = 0; let device = 0;
  try {
    // Existing settings may be readable; the new credential-bearing file is private.
    const bytes = await readBoundedFile(path, { maximum: limit, fail: () => new SetupError('invalid_state'),
      attest: async (target, st) => { await owner.attest(target, false); inode = st.ino; device = st.dev; } });
    return { bytes, inode, device };
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}
export async function configureClient(owner: OwnerProfile, client: ClientKind, port: number, token: string, replace = false): Promise<{ client: ClientKind; evidence: 'configuration_written'; tool_loading_verified: false }> {
  try {
    if (!['codex', 'claude', 'opencode', 'hermes'].includes(client) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new SetupError('invalid_request');
    await owner.authorize(); await owner.attest(owner.home, false);
    const parts = clientRelativePath(client); const path = join(owner.home, ...parts);
    let directory = owner.home;
    for (const part of parts.slice(0, -1)) {
      await owner.attest(directory, false); directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      await owner.attest(directory, false);
    }
    const prior = await readExisting(path, owner);
    const text = patchClientConfig(client, prior ? new TextDecoder('utf-8', { fatal: true }).decode(prior.bytes) : '', port, token, replace);
    const next = Buffer.from(text);
    if (prior?.bytes.equals(next)) {
      // Matching configuration is still not proof that a model loaded tools.
      await owner.attest(path, true);
      return { client, evidence: 'configuration_written', tool_loading_verified: false };
    }
    const temporary = join(dirname(path), `.telegram-gateway-${randomUUID()}.next`);
    const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await owner.preparePrivateFile?.(temporary);
      await owner.attest(temporary, true);
      await fd.writeFile(next); await fd.sync(); await fd.close(); await owner.attest(temporary, true);
      await owner.attest(directory, false);
      const current = await readExisting(path, owner);
      if ((prior === null) !== (current === null) || (prior && current && (!prior.bytes.equals(current.bytes) || prior.inode !== current.inode || prior.device !== current.device))) throw new SetupError('invalid_state');
      await rename(temporary, path); await owner.attest(path, true);
    } finally { await fd.close(); await unlink(temporary).catch(() => undefined); }
    return { client, evidence: 'configuration_written', tool_loading_verified: false };
  } catch (err) { if (err instanceof ClientEntryConflict) throw err; throw new SetupError('invalid_state'); }
}
export async function readSelectedClientTokens(owner: OwnerProfile, clients: ClientKind[], port: number): Promise<string[]> {
  const tokens: string[]=[];
  await owner.authorize(); await owner.attest(owner.home, false);
  for (const client of clients) {
    const path = join(owner.home, ...clientRelativePath(client));
    try {
      await owner.attest(dirname(path), false);
      const existing = await readExisting(path, owner);
      const token = existing ? configuredGatewayToken(client, new TextDecoder('utf-8', { fatal: true }).decode(existing.bytes), port) : null;
      if(token&&!tokens.includes(token))tokens.push(token);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new SetupError('invalid_state'); }
  }
  return tokens;
}
