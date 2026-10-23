import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient } from 'teleproto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStorage } from '../../storage/sqlite.js';
import { ownerSetup, pendingClientToken, acknowledgeClientToken, type OwnerWorkerDeps, type OwnerPlan } from '../owner.js';
import { ApiCredentialFile } from '../credentials.js';
import { sha256Hex, unseal } from '../../core/crypto.js';

const plan: OwnerPlan = { setup_id: '12345678-1234-4234-8234-123456789012', account: 'fixture_account', user: 'fixture_user', replace_session: false, rotate_token: false, clients: [] };
const stores: SqliteStorage[]=[];const roots: string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture() {
  const storage=new SqliteStorage({path:':memory:'});stores.push(storage);const output: string[]=[];const events: string[]=[];
  let credentials: {apiId:number;apiHash:string}|null=null;
  const prompts=vi.fn(async (question: string,options?: {hidden?:boolean})=>{
    expect(options?.hidden).toBe(true);
    if(question.includes('application id'))return '12345';if(question.includes('application hash'))return 'a'.repeat(32);
    if(question.includes('phone'))return '+79990000000';if(question.includes('code'))return '12345';return 'fixture-2fa-secret';
  });
  const factory=vi.fn(()=>({
    invoke:vi.fn(async()=>({})),session:{save:()=> 'fixture-session-secret'},destroy:vi.fn(async()=>{events.push('destroy')}),
    start:vi.fn(async(params:{phoneCode:()=>Promise<string>;password:(hint?:string)=>Promise<string>})=>{
      events.push('start');await params.phoneCode();await params.password('fixture-private-hint');
    }),getMe:vi.fn(async()=>({id:555n,username:'fixture-private-name',firstName:'Fixture'})),
  }) as unknown as TelegramClient);
  const deps: OwnerWorkerDeps={storage,sessionSecret:'fixture-encryption-secret',factory,
    authorize:async()=>{events.push('authorize')},withSetupLease:async work=>{events.push('setup-lease');return work()},
    withStoppedDaemon:async work=>{events.push('stop-and-lock');try{return await work()}finally{events.push('release-and-restore')}},
    credentials:{read:async()=>credentials,write:async value=>{credentials=value}},
    io:{out:s=>output.push(s),err:s=>output.push(s),prompt:prompts},
  };
  return {deps,storage,output,events,factory,prompts};
}
describe('authorized owner worker core',()=>{
  it('logs in only after authorization/stopped ownership and emits no credentials/session/token',async()=>{
    const f=fixture();const result=await ownerSetup(plan,f.deps);expect(result.phase).toBe('needs_client_configuration');
    expect(f.events).toEqual(['authorize','setup-lease','stop-and-lock','start','destroy','release-and-restore']);
    const session=f.storage.sessions.get(plan.account)!;expect(unseal(session,f.deps.sessionSecret)).toBe('fixture-session-secret');
    const pending=pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)!;
    expect(f.storage.users.get(plan.user)?.tokenSha256).toBe(sha256Hex(pending.token));
    const text=JSON.stringify(result)+f.output.join('');
    for(const secret of [pending.token,'fixture-session-secret','fixture-2fa-secret','fixture-private-hint','fixture-private-name','+79990000000','a'.repeat(32)])expect(text).not.toContain(secret);
  });
  it('does not relogin, rotate tokens or reset scopes when repeating completed setup',async()=>{
    const f=fixture();await ownerSetup(plan,f.deps);const session=f.storage.sessions.get(plan.account);const token=pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)!.token;
    f.storage.scopes.put({userId:plan.user,accountId:plan.account,target:'private-test',effect:'allow'});
    f.events.length=0;f.prompts.mockClear();expect((await ownerSetup(plan,f.deps)).phase).toBe('needs_client_configuration');
    expect(f.factory).toHaveBeenCalledTimes(1);expect(f.prompts).not.toHaveBeenCalled();expect(f.storage.sessions.get(plan.account)).toEqual(session);
    expect(pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)!.token).toBe(token);expect(f.storage.scopes.list(plan.user,plan.account)).toHaveLength(1);
  });
  it('retains pending handoff for retry and clears it only on matching receipt',async()=>{
    const f=fixture();await ownerSetup(plan,f.deps);const pending=pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)!;
    expect(()=>acknowledgeClientToken(f.storage,plan.setup_id,'wrong-hash')).toThrow('invalid_state');
    expect(pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)).toEqual(pending);
    acknowledgeClientToken(f.storage,plan.setup_id,sha256Hex(pending.token));expect(pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)).toBeNull();
    expect((await ownerSetup(plan,f.deps)).phase).toBe('needs_existing_client_credential');expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('rejects unauthorized entry before prompts, client creation or storage mutation',async()=>{
    const f=fixture();f.deps.authorize=async()=>{throw new Error('fixture-secret')};
    const result=await ownerSetup(plan,f.deps);expect(result.phase).toBe('failed');expect(f.prompts).not.toHaveBeenCalled();expect(f.factory).not.toHaveBeenCalled();expect(f.storage.users.list()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('cancels human input without issuing accounts or caching an unverified API pair',async()=>{
    const f=fixture();f.prompts.mockImplementation(async question=>{if(question.includes('phone'))throw new Error('fixture-secret-cancel');return question.includes('id')?'12345':'a'.repeat(32)});
    expect((await ownerSetup(plan,f.deps)).phase).toBe('failed');expect(f.factory).not.toHaveBeenCalled();expect(f.storage.sessions.get(plan.account)).toBeNull();expect(f.storage.users.list()).toEqual([]);
    expect(await f.deps.credentials.read()).toBeNull();
  });
  it('refuses an existing session without API credentials before asking for secrets',async()=>{
    const f=fixture();await ownerSetup(plan,f.deps);f.deps.credentials.read=async()=>null;f.prompts.mockClear();
    expect(await ownerSetup(plan,f.deps)).toMatchObject({phase:'failed',error_code:'owner_step_failed'});
    expect(f.prompts).not.toHaveBeenCalled();expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('persists an authorized login and new API pair before cleanup terminates the worker',async()=>{
    const f=fixture();const make=f.factory.getMockImplementation()!;
    f.factory.mockImplementationOnce(()=>{const client=make() as unknown as {destroy:()=>Promise<void>};
      client.destroy=async()=>{f.events.push('destroy');throw new Error('synthetic close failure')};return client as unknown as TelegramClient});
    f.deps.onFatal=()=>{f.events.push('fatal');throw new Error('fixture-worker-exit')};
    expect((await ownerSetup(plan,f.deps)).phase).toBe('failed');
    expect(f.events).toEqual(['authorize','setup-lease','stop-and-lock','start','destroy','fatal','release-and-restore']);
    expect(unseal(f.storage.sessions.get(plan.account)!,f.deps.sessionSecret)).toBe('fixture-session-secret');
    expect(await f.deps.credentials.read()).toEqual({apiId:12345,apiHash:'a'.repeat(32)});
    // A rerun after the forced exit reuses the stored session instead of requesting a new code.
    f.prompts.mockClear();expect((await ownerSetup(plan,f.deps)).phase).toBe('needs_client_configuration');
    expect(f.prompts).not.toHaveBeenCalled();expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('requires explicit token rotation and preserves sessions when it is approved',async()=>{
    const f=fixture();await ownerSetup(plan,f.deps);const old=f.storage.users.get(plan.user)!.tokenSha256;
    expect((await ownerSetup({...plan,rotate_token:true},f.deps)).phase).toBe('needs_client_configuration');
    expect(f.storage.users.get(plan.user)!.tokenSha256).not.toBe(old);expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('fails safely when protected pending ciphertext is corrupted',async()=>{
    const f=fixture();await ownerSetup(plan,f.deps);f.storage.kv.set(`setup.handoff.${plan.setup_id}`,'{"token":"fixture-secret"}');
    expect(()=>pendingClientToken(f.storage,plan.setup_id,f.deps.sessionSecret)).toThrow('invalid_state');
    expect((await ownerSetup(plan,f.deps)).phase).toBe('failed');
  });
});
describe.skipIf(process.platform==='win32')('private API credential file',()=>{
  it('preserves unrelated settings with an atomic private write',async()=>{
    const root=mkdtempSync(join(tmpdir(),'tg-owner-'));roots.push(root);const file=new ApiCredentialFile(root,async()=>undefined);
    writeFileSync(join(root,'.env'),'TG_MCP_LIMIT_REPLIES=12\n',{mode:0o600});expect(await file.read()).toBeNull();
    await file.write({apiId:12345,apiHash:'a'.repeat(32)});expect(await file.read()).toEqual({apiId:12345,apiHash:'a'.repeat(32)});
    expect(readFileSync(join(root,'.env'),'utf8')).toContain('TG_MCP_LIMIT_REPLIES=12');
  });
  it('rejects foreign-readable credentials instead of silently rewriting them',async()=>{
    const root=mkdtempSync(join(tmpdir(),'tg-owner-'));roots.push(root);writeFileSync(join(root,'.env'),'TG_API_ID=1\nTG_API_HASH='+ 'a'.repeat(32)+'\n');chmodSync(join(root,'.env'),0o644);
    const file=new ApiCredentialFile(root,async()=>undefined);await expect(file.read()).rejects.toThrow('invalid_state');
  });
});
