import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { privateExchange, privateLines } from '../promptChannel.js';

// Real processes over real pipes: a pending read on an open pipe keeps Node alive, which in-process streams cannot show.
const channel = JSON.stringify(new URL('../../../dist/setup/promptChannel.js', import.meta.url).href);
const setupId = '123e4567-e89b-42d3-a456-426614174000';
const plan = JSON.stringify({ kind: 'plan', plan: { setup_id: setupId, account: 'example', user: 'example', clients: [] }, existing_tokens: [] }) + '\n';
const exitBound = 5000;
/** released: the shipped child lifecycle; unreleased: a main() that returns without releasing stdin; failing: throws after its first read. */
const worker = (mode: 'released' | 'unreleased' | 'failing'): string => `
  import { privateLines, runPrivateProcess, sendPrivate } from ${channel};
  const main = async () => {
    const input = privateLines(process.stdin)[Symbol.asyncIterator]();
    const first = await input.next(); if (first.done) throw new Error('closed');
    if (${JSON.stringify(mode)} === 'failing') throw new Error('synthetic private failure');
    const { plan } = JSON.parse(first.value);
    await sendPrivate(process.stdout, { kind: 'result', result: { format_version: 1, setup_id: plan.setup_id, phase: 'needs_client_configuration', error_code: null } });
    return 0;
  };
  if (${JSON.stringify(mode)} === 'unreleased') main().then(code => { process.exitCode = code; });
  else runPrivateProcess(main, 'owner_step_failed');`;
/** Coordinator shape: profile frame, plan from its parent, worker exchange, forwarded final frame. */
const coordinator = `
  import { spawn } from 'node:child_process'; import { once } from 'node:events';
  import { privateExchange, privateLines, runPrivateProcess, sendPrivate } from ${channel};
  const main = async () => {
    const parent = privateLines(process.stdin)[Symbol.asyncIterator]();
    await sendPrivate(process.stdout, { kind: 'profile', setup_id: ${JSON.stringify(setupId)}, port: 4100 });
    const first = await parent.next(); if (first.done) throw new Error('closed');
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker('released'))}], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(child, 'close').then(([code]) => code);
    const exchange = privateExchange(child.stdout, child.stdin, 3000); let result = null;
    await sendPrivate(child.stdin, JSON.parse(first.value));
    for await (const line of exchange.frames) { if (result) throw new Error('extra frame'); result = JSON.parse(line); exchange.finish(); }
    if (await exited !== 0 || result?.kind !== 'result') throw new Error('worker failed');
    await sendPrivate(process.stdout, result);
    return 0;
  };
  runPrivateProcess(main, 'owner_step_failed');`;

type Peer = ChildProcessByStdio<Writable, Readable, Readable>;
function start(script: string): { child: Peer; stderr: () => string; exitWithin: (ms: number) => Promise<number | null | 'alive'> } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'close').then(([code]) => code as number | null);
  return { child, stderr: () => stderr, exitWithin: async ms => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([exited, new Promise<'alive'>(resolve => { timer = setTimeout(() => resolve('alive'), ms); })]); }
    finally { clearTimeout(timer); }
  } };
}
async function cleanup(child: Peer): Promise<void> { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } }

describe('private channel process lifecycle', () => {
  it('a finished child releases stdin and exits although its parent keeps the pipe open', async () => {
    const peer = start(worker('released'));
    try {
      peer.child.stdin.write(plan);
      const first = await privateLines(peer.child.stdout)[Symbol.asyncIterator]().next();
      expect(JSON.parse(first.value).kind).toBe('result');
      expect(await peer.exitWithin(exitBound)).toBe(0);
    } finally { await cleanup(peer.child); }
  }, 20000);
  it('a failing child releases stdin with only the fixed error code', async () => {
    const peer = start(worker('failing'));
    try {
      peer.child.stdin.write(plan);
      expect(await peer.exitWithin(exitBound + 5000)).toBe(1);
      expect(peer.stderr()).toBe('{"format_version":1,"error_code":"owner_step_failed"}\n');
    } finally { await cleanup(peer.child); }
  }, 20000);
  it('the parent ends input after the final frame, so even an unreleased child exits', async () => {
    const peer = start(worker('unreleased'));
    try {
      const exchange = privateExchange(peer.child.stdout, peer.child.stdin); const frames: string[] = [];
      peer.child.stdin.write(plan);
      for await (const line of exchange.frames) { frames.push(line); exchange.finish(); }
      expect(frames.map(line => JSON.parse(line).kind)).toEqual(['result']);
      expect(await peer.exitWithin(exitBound)).toBe(0);
    } finally { await cleanup(peer.child); }
  }, 20000);
  it('the parent ends input when the exchange fails, so an unreleased child exits', async () => {
    const peer = start(worker('unreleased'));
    try {
      const exchange = privateExchange(peer.child.stdout, peer.child.stdin);
      peer.child.stdin.write(plan);
      await expect((async () => { for await (const line of exchange.frames) throw new Error(`unexpected ${JSON.parse(line).kind}`); })()).rejects.toThrow('unexpected result');
      expect(await peer.exitWithin(exitBound)).toBe(0);
    } finally { await cleanup(peer.child); }
  }, 20000);
  it('bounds the wait for a peer that keeps its output open after the final frame', async () => {
    const peer = start(`process.stdout.write('{"kind":"result"}\\n'); setInterval(() => undefined, 1000);`);
    try {
      const exchange = privateExchange(peer.child.stdout, peer.child.stdin, 300);
      await expect((async () => { for await (const _line of exchange.frames) exchange.finish(); })()).rejects.toThrow('private peer exit');
    } finally { await cleanup(peer.child); }
  }, 20000);
  it('launcher, coordinator and worker all exit promptly after the final frame', async () => {
    const peer = start(coordinator);
    try {
      const exchange = privateExchange(peer.child.stdout, peer.child.stdin); const kinds: string[] = [];
      for await (const line of exchange.frames) {
        const message = JSON.parse(line); kinds.push(message.kind);
        if (message.kind === 'profile') peer.child.stdin.write(plan);
        else { expect(message.result.setup_id).toBe(setupId); exchange.finish(); }
      }
      expect(kinds).toEqual(['profile', 'result']);
      expect(await peer.exitWithin(exitBound)).toBe(0);
      expect(peer.stderr()).toBe('');
    } finally { await cleanup(peer.child); }
  }, 30000);
});
