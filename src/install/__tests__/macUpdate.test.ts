import { describe, expect, it, vi } from 'vitest';
import { applyMacUpdate } from '../macUpdate.js';
import type { ProvisionReceipt } from '../provision.js';

type Ops = Parameters<typeof applyMacUpdate>[1];
const previous: ProvisionReceipt = {
  format_version: 1, identity: { kind: 'posix', uid: 450, gid: 450 },
  completed: ['identity', 'release', 'state', 'definition', 'commands'],
  plan: { format_version: 1, setup_id: '12345678-1234-4234-8234-123456789012',
    source_sha: 'a'.repeat(40), signer_sha256: 'c'.repeat(64), platform: 'darwin', port: 18547 },
};
const target = { ...previous.plan, source_sha: 'b'.repeat(40) };
function fixture(running = true) {
  let saved = structuredClone(previous);
  let journal: Awaited<ReturnType<Ops['journal']>> = null;
  const events: string[] = [];
  const ops: Ops = {
    receipt: async () => saved, journal: async () => journal,
    begin: async value => { journal = structuredClone(value); events.push(value.phase); },
    discardStaging: async () => { events.push('discard staging'); },
    finish: async () => { journal = null; events.push('finish'); },
    inspectPrevious: async () => ({ legacyOwner: true, coreOnly: true }),
    stage: async () => { events.push('stage'); },
    stop: async () => { events.push('stop'); return { wasRunning: running,
      restore: async (_activate, verify) => { events.push('restore'); await verify?.(); } }; },
    switchBindings: async (_journal, forward) => { events.push(forward ? 'switch' : 'rollback'); },
    verify: async () => { events.push('verify'); },
    commit: async value => { saved = structuredClone(value); events.push('commit'); },
    listener: async receipt => { events.push(receipt.plan.source_sha === target.source_sha ? 'new listener' : 'old listener'); },
  };
  return { ops, events, run: () => applyMacUpdate(target, ops, () => {}) };
}

describe('managed macOS application update', () => {
  it('retains setup id, port and service identity and verifies the listener before clearing recovery state', async () => {
    const f = fixture();
    expect(await f.run()).toBe('updated');
    expect(await f.ops.receipt()).toEqual({ ...previous, plan: target });
    expect(f.events).toEqual(['staging','stage','switching','stop','switch','verify','commit','restore','new listener','finish']);
    f.events.length = 0;
    expect(await f.run()).toBe('already_current');
    expect(f.events).toEqual(['verify']);
  });
  it('preserves a previously inactive service', async () => {
    const f = fixture(false);
    expect(await f.run()).toBe('updated');
    expect(f.events).not.toContain('new listener');
  });
  it.each([{ platform: 'linux' as const }, { port: 7777 }, { signer_sha256: 'f'.repeat(64) }])('rejects changed installation identity before staging: %j', async change => {
    const f = fixture();
    await expect(applyMacUpdate({ ...target, ...change }, f.ops, () => {})).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it('keeps the running installation on a stage failure', async () => {
    const f = fixture(); f.ops.stage = async () => { throw new Error('disk full'); };
    await expect(f.run()).rejects.toThrow('disk full');
    expect(f.events).toEqual(['staging']);
    expect(await f.ops.receipt()).toEqual(previous);
  });
  it('restores prior files and service after a failure before the new receipt commits', async () => {
    const f = fixture(); f.ops.verify = async () => { throw new Error('file mismatch'); };
    await expect(f.run()).rejects.toThrow('file mismatch');
    expect(f.events.slice(-4)).toEqual(['rollback','restore','old listener','finish']);
    expect(await f.ops.journal()).toBeNull();
    expect(await f.ops.receipt()).toEqual(previous);
  });
  it('resumes the exact signed update after activation fails, without reverting migrated state', async () => {
    const f = fixture(); const listener = f.ops.listener;
    f.ops.listener = vi.fn().mockRejectedValue(new Error('startup delayed'));
    await expect(f.run()).rejects.toThrow('startup delayed');
    expect(await f.ops.journal()).toBeTruthy();
    expect(f.events).not.toContain('rollback');
    await expect(applyMacUpdate(previous.plan, f.ops, () => {})).rejects.toThrow();
    f.ops.listener = listener;
    expect(await f.run()).toBe('updated');
    expect(f.events.slice(-3)).toEqual(['restore','new listener','finish']);
  });
  it('allows a signed fix forward after a committed release cannot start', async () => {
    const f = fixture();
    const listener = f.ops.listener;
    f.ops.listener = async () => { throw new Error('broken release'); };
    await expect(f.run()).rejects.toThrow('broken release');
    const repair = { ...target, source_sha: 'd'.repeat(40) };
    f.ops.listener = listener;
    expect(await applyMacUpdate(repair, f.ops, () => {})).toBe('updated');
    expect((await f.ops.receipt()).plan).toEqual(repair);
  });

  it('reuses its private staging name after interruption', async () => {
    const f = fixture(); const stage = f.ops.stage;
    f.ops.stage = async () => { throw new Error('interrupted'); };
    await expect(f.run()).rejects.toThrow();
    const stagingId = (await f.ops.journal())!.stagingId;
    f.ops.stage = async (receipt, id) => { expect(id).toBe(stagingId); await stage(receipt, id); };
    expect(await f.run()).toBe('updated');
  });

  it('can replace a failed staging attempt during recovery from a broken active build', async () => {
    const f = fixture();
    const { stage, listener } = f.ops;
    f.ops.listener = async () => { throw new Error('broken active release'); };
    await expect(f.run()).rejects.toThrow();
    const badRepair = { ...target, source_sha: 'c'.repeat(40) };
    f.ops.stage = async () => { throw new Error('staging interrupted'); };
    await expect(applyMacUpdate(badRepair, f.ops, () => {})).rejects.toThrow('staging interrupted');
    expect((await f.ops.journal())?.phase).toBe('staging');
    f.ops.stage = stage; f.ops.listener = listener;
    const goodRepair = { ...target, source_sha: 'd'.repeat(40) };
    expect(await applyMacUpdate(goodRepair, f.ops, () => {})).toBe('updated');
    expect(f.events).toContain('discard staging');
    expect((await f.ops.receipt()).plan).toEqual(goodRepair);
  });

  it('accepts a second repair after rolling back files to an unhealthy daemon', async () => {
    const f = fixture();
    const { listener, verify, inspectPrevious } = f.ops;
    f.ops.listener = async () => { throw new Error('unhealthy'); };
    await expect(f.run()).rejects.toThrow();
    const bad = { ...target, source_sha: 'c'.repeat(40) };
    f.ops.verify = async () => { throw new Error('bad files'); };
    await expect(applyMacUpdate(bad, f.ops, () => {})).rejects.toThrow('unhealthy');
    const good = { ...target, source_sha: 'd'.repeat(40) };
    f.ops.inspectPrevious = async () => { throw new Error('mixed files'); };
    await expect(applyMacUpdate(good, f.ops, () => {})).rejects.toThrow('mixed files');
    f.ops.inspectPrevious = inspectPrevious; f.ops.verify = verify; f.ops.listener = listener;
    expect(await applyMacUpdate(good, f.ops, () => {})).toBe('updated');
  });

});
