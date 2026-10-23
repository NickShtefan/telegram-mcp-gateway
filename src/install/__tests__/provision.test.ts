import { describe, expect, it, vi } from 'vitest';
import { provision, type ProvisionBackend, type ProvisionPlan, type ProvisionReceipt } from '../provision.js';
import { installLayout, serviceDefinition } from '../platform.js';
import { SetupError } from '../../setup/contract.js';

const plan: ProvisionPlan = { format_version: 1, setup_id: '12345678-1234-4234-8234-123456789012',
  source_sha: 'a'.repeat(40), signer_sha256: 'b'.repeat(64), platform: 'darwin', port: 7777 };
function fake(): ProvisionBackend & { receipt: unknown | null; events: string[] } {
  return {
    receipt: null, events: [],
    attest: vi.fn(async () => undefined), withExclusive: async work => work(),
    async readReceipt() { return this.receipt; }, async saveReceipt(r) { this.receipt = structuredClone(r); },
    inspect: vi.fn(async () => true),
    async createIdentity() { this.events.push('identity'); return { kind: 'posix', uid: 450, gid: 450 }; },
    async installRelease() { this.events.push('release'); }, async createState() { this.events.push('state'); },
    async installDefinition() { this.events.push('definition'); }, async installCommands() { this.events.push('commands'); },
  };
}
describe('fixed platform service definitions', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('uses a separate fixed identity for %s', platform => {
    const layout=installLayout(platform,plan.source_sha); const definition=serviceDefinition(layout,7777);
    if(platform==='win32')expect(JSON.parse(definition).account).toBe(layout.account);else expect(definition).toContain(layout.account);
    expect(definition).toContain('core');
    expect(definition).not.toContain('API_HASH');expect(definition).not.toContain('TG_MCP_TOKEN');
    expect(definition).not.toContain('NODE_OPTIONS');
  });
  it('installs macOS disabled and Linux without automatic enable/start', () => {
    expect(serviceDefinition(installLayout('darwin',plan.source_sha),7777)).toContain('<key>Disabled</key><true/>');
    const unit=serviceDefinition(installLayout('linux',plan.source_sha),7777);
    expect(unit).toContain('NoNewPrivileges=true');expect(unit).toContain('ProtectSystem=strict');
    expect(unit).not.toContain('ExecStartPre=');
  });
  it('rejects injected paths, source identities and ports', () => {
    expect(()=>installLayout('darwin','../fixture')).toThrow('invalid_installation_plan');
    expect(()=>serviceDefinition({...installLayout('linux',plan.source_sha),node:'/tmp/agent-node'},7777)).toThrow('invalid_installation_plan');
    expect(()=>serviceDefinition(installLayout('win32',plan.source_sha),NaN)).toThrow('invalid_installation_plan');
  });
});
describe('isolated provisioning transitions', () => {
  it('attests before side effects and never starts a daemon or asks for secrets', async () => {
    const backend=fake();expect(await provision(plan,backend)).toMatchObject({phase:'needs_api_credentials',error_code:null,service_started:false});
    expect(backend.events).toEqual(['identity','release','state','definition','commands']);
    expect((backend.receipt as ProvisionReceipt).identity).toEqual({kind:'posix',uid:450,gid:450});
    backend.events.length=0;await provision(plan,backend);expect(backend.events).toEqual([]);
  });
  it('resumes completed steps after a later-stage failure without replacing the identity', async () => {
    const backend=fake();backend.installDefinition=async()=>{throw new Error('fixture-secret')};
    expect((await provision(plan,backend)).phase).toBe('failed');
    expect((backend.receipt as ProvisionReceipt).completed).toEqual(['identity','release','state']);
    backend.events.length=0;backend.installDefinition=async()=>{backend.events.push('definition')};
    expect((await provision(plan,backend)).phase).toBe('needs_api_credentials');
    expect(backend.events).toEqual(['definition','commands']);
  });
  it('fails closed before mutation if owner/code/artifact attestation fails', async () => {
    const backend=fake();backend.attest=async()=>{throw new SetupError('protection_unverified')};
    expect((await provision(plan,backend)).error_code).toBe('protection_unverified');expect(backend.events).toEqual([]);expect(backend.receipt).toBeNull();
  });
  it('does not trust a receipt when actual state inspection fails', async () => {
    const backend=fake();await provision(plan,backend);const saved=backend.receipt;backend.events.length=0;backend.inspect=async()=>false;
    expect((await provision(plan,backend)).error_code).toBe('protection_unverified');expect(backend.events).toEqual([]);expect(backend.receipt).toBe(saved);
  });
  it('rejects changed plans, invalid/future/private/out-of-order receipts without overwriting them', async () => {
    const backend=fake();await provision(plan,backend);const good=backend.receipt as ProvisionReceipt;
    for(const bad of [{...good,token:'fixture-secret'},{...good,format_version:2},{...good,completed:['commands']},{...good,identity:{kind:'posix',uid:0,gid:0}}]) {
      backend.receipt=bad;backend.events.length=0;
      const result=await provision(plan,backend);expect(result.error_code).toBe('invalid_state');expect(backend.receipt).toBe(bad);expect(backend.events).toEqual([]);expect(JSON.stringify(result)).not.toContain('fixture-secret');
    }
    backend.receipt=good;expect((await provision({...plan,port:8888},backend)).error_code).toBe('invalid_state');
  });
  it('requires a virtual service SID for Windows and rejects owner/root identities', async () => {
    const backend=fake();expect((await provision({...plan,platform:'win32'},backend)).error_code).toBe('invalid_state');
    const windows=fake();windows.createIdentity=async()=>({kind:'windows',sid:'S-1-5-80-1-2-3-4-5'});
    expect((await provision({...plan,platform:'win32'},windows)).phase).toBe('needs_api_credentials');
  });
});
