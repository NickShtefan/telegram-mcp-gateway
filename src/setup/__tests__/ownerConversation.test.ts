import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../../cli/io.js';
import { privateLines, sendPrivate } from '../promptChannel.js';
import { runOwnerConversation, runOwnerAttempts, type OwnerConversation } from '../ownerConversation.js';
import { apiInstructions, elevationNotice } from '../presentation.js';
import { SetupError } from '../contract.js';
import { ClientEntryConflict } from '../clientConfig.js';
import type { ClientKind } from '../clientCatalog.js';

type Question = 'api_id' | 'api_hash' | 'phone' | 'code' | 'password' | 'login_method';
const sha = 'a'.repeat(40);
const preview = { setup_id: '123e4567-e89b-42d3-a456-426614174000', account: 'personal', user: 'owner', replace_session: false, rotate_token: false, clients: [] };
const rerunCommand = '"/fixture/bin/tg-mcp-owner" setup';
afterEach(() => vi.useRealTimers());

/** Fake elevated coordinator: profile, the requested private questions, then a final result frame. */
function harness(questions: Question[], qrAfterMethod = false): { conversation: OwnerConversation; events: string[]; answers: unknown[] } {
  const events: string[] = []; const answers: unknown[] = [];
  const io: CliIo = { out: line => events.push(`out:${line}`), err: line => events.push(`err:${line}`),
    prompt: async (question, options) => { events.push(`${options?.hidden ? 'hidden' : 'visible'}:${question}`); return `private-example-${events.length}`; } };
  const conversation: OwnerConversation = { io, platform: 'darwin', sha, preview: { ...preview, clients: [] }, rerunCommand,
    elevate: async () => {
      events.push('elevate');
      const toLauncher = new PassThrough(); const fromLauncher = new PassThrough();
      void (async () => {
        const frames = privateLines(fromLauncher)[Symbol.asyncIterator]();
        await sendPrivate(toLauncher, { kind: 'profile', setup_id: preview.setup_id, port: 4100 });
        const plan = JSON.parse((await frames.next()).value as string);
        let sequence = 0;
        for (const question of questions) {
          await sendPrivate(toLauncher, { kind: 'prompt', sequence: ++sequence, question });
          answers.push(JSON.parse((await frames.next()).value as string));
          if (question === 'login_method' && qrAfterMethod) await sendPrivate(toLauncher, { kind: 'qr', token: Buffer.from('synthetic token').toString('base64url'), expires: 2000000000 });
        }
        await sendPrivate(toLauncher, { kind: 'result', result: { format_version: 1, setup_id: plan.plan.setup_id, phase: 'needs_existing_client_credential', error_code: null } });
        toLauncher.end();
      })().catch(() => toLauncher.destroy());
      return { input: toLauncher, output: fromLauncher, closing: async () => { events.push('closed'); return 0; } };
    },
    existingTokens: async () => [], configure: async () => { throw new Error('unexpected configuration'); }, probe: async () => false };
  return { conversation, events, answers };
}

describe('owner conversation ordering', () => {
  it('waits for confirmed coordinator cleanup before restarting a switched browser attempt',async()=>{
    const f=harness([]);const first=new AbortController();let release!:()=>void;let ready!:()=>void;
    const waiting=new Promise<void>(resolve=>{ready=resolve;});const cleanup=new Promise<void>(resolve=>{release=resolve;});
    const normal=f.conversation.elevate;let calls=0;let life=first;
    const ui={get signal(){return life.signal},answer:async()=>new Promise<string>(()=>undefined),qr:()=>undefined,finish:()=>undefined,close:async()=>undefined,
      takeRetry:vi.fn(async()=>{life=new AbortController();return {mode:'console' as const,method:'phone' as const};})};
    f.conversation.loginUi=ui;f.conversation.preview.browser_login=true;f.conversation.io.prompt=async()=>'';
    f.conversation.elevate=async()=>{
      if(++calls>1)return normal();
      const input=new PassThrough(),output=new PassThrough();input.on('error',()=>undefined);
      queueMicrotask(()=>{ready();first.abort();});
      return {input,output,closing:async()=>{await cleanup;f.events.push('old-worker-gone');return 1;}};
    };
    const pending=runOwnerAttempts(f.conversation);await waiting;await new Promise(resolve=>setImmediate(resolve));
    expect(calls).toBe(1);expect(ui.takeRetry).not.toHaveBeenCalled();release();
    expect(await pending).toBe(0);expect(calls).toBe(2);expect(ui.takeRetry).toHaveBeenCalledOnce();
    expect(f.events.indexOf('old-worker-gone')).toBeLessThan(f.events.indexOf('elevate'));
    expect(f.conversation.preview.browser_login).toBe(false);
  });
  it('never retries when coordinator termination could not be confirmed',async()=>{
    const f=harness([]);const life=new AbortController();const retry=vi.fn(async()=>({mode:'browser' as const,method:'phone' as const}));
    f.conversation.loginUi={signal:life.signal,answer:async()=>'',qr:()=>undefined,finish:()=>undefined,close:async()=>undefined,takeRetry:retry};
    f.conversation.elevate=async()=>{const input=new PassThrough();input.on('error',()=>undefined);queueMicrotask(()=>life.abort());return {input,output:new PassThrough(),closing:async()=>{throw new Error('cleanup-unconfirmed');}};};
    await expect(runOwnerAttempts(f.conversation)).rejects.toThrow('cleanup-unconfirmed');expect(retry).not.toHaveBeenCalled();
  });
  it('routes browser answers and QR displays through the private channel without terminal secret prompts',async()=>{
    const f=harness(['api_id','api_hash','login_method','password'],true);
    const ui={signal:new AbortController().signal,answer:vi.fn(async(question:string)=>question==='login_method'?'qr':'private-fixture'),qr:vi.fn(),finish:vi.fn(),close:vi.fn(async()=>undefined)};
    f.conversation.preview={...preview,browser_login:true};f.conversation.loginUi=ui;
    expect(await runOwnerConversation(f.conversation)).toBe(0);
    expect(ui.answer.mock.calls.map(([question])=>question)).toEqual(['api_id','api_hash','login_method','password']);
    expect(ui.qr).toHaveBeenCalledOnce();expect(ui.finish).toHaveBeenCalledWith(true,[]);
    expect(f.events.some(event=>event.startsWith('hidden:'))).toBe(false);
    expect(f.events.join('\n')).not.toContain('private-fixture');
    expect(f.events.join('\n')).not.toContain(Buffer.from('synthetic token').toString('base64url'));
  });
  it.each([{clients:['cursor','openclaw'] as ClientKind[]},{clients:[] as ClientKind[]}])('selects apps after login and writes only the chosen profiles: $clients',async({clients})=>{
    const toLauncher=new PassThrough(),fromLauncher=new PassThrough();const frames=privateLines(fromLauncher)[Symbol.asyncIterator]();
    const token='synthetic_credential_012345678901234567890';const reads:ClientKind[][]=[];const writes:Array<[ClientKind,boolean]>=[];
    const selectedPreview={...preview,clients:[] as ClientKind[],browser_login:true};
    const ui={signal:new AbortController().signal,answer:vi.fn(async(question:string)=>question==='clients'?JSON.stringify(clients):'REPLACE'),qr:vi.fn(),finish:vi.fn(),close:vi.fn(async()=>undefined)};
    const conversation:OwnerConversation={io:{out:vi.fn(),err:vi.fn(),prompt:vi.fn(async()=>{throw new Error('unexpected console input')})},platform:'darwin',sha,preview:selectedPreview,rerunCommand,loginUi:ui,
      elevate:async()=>({input:toLauncher,output:fromLauncher,closing:async()=>0}),
      existingTokens:async()=>{reads.push([...selectedPreview.clients]);return [];},
      configure:async(client,_port,_token,replace)=>{writes.push([client,replace]);if(client==='cursor'&&!replace)throw new ClientEntryConflict();},probe:async()=>true};
    const worker=(async()=>{
      await sendPrivate(toLauncher,{kind:'profile',setup_id:preview.setup_id,port:4100});
      const initial=JSON.parse((await frames.next()).value as string);expect(initial.plan.clients).toEqual([]);
      await sendPrivate(toLauncher,{kind:'client_selection'});
      const selection=JSON.parse((await frames.next()).value as string);expect(selection).toEqual({kind:'clients',clients,existing_tokens:[]});
      if(clients.length){
        await sendPrivate(toLauncher,{kind:'handoff',setup_id:initial.plan.setup_id,port:4100,token,clients,service_evidence:'listener_owned_by_service'});
        expect(JSON.parse((await frames.next()).value as string).kind).toBe('client_ack');
      }
      await sendPrivate(toLauncher,{kind:'result',result:{format_version:1,setup_id:initial.plan.setup_id,phase:clients.length?'needs_service_start':'needs_client_configuration',error_code:null}});toLauncher.end();
    })();worker.catch(()=>undefined);
    expect(await runOwnerConversation(conversation)).toBe(0);await worker;
    expect(reads).toEqual([[],clients]);expect(writes).toEqual(clients.length?[['cursor',false],['cursor',true],['openclaw',false]]:[]);
    expect(ui.finish).toHaveBeenCalledWith(true,clients);
    if(clients.length)expect(ui.answer).toHaveBeenCalledWith('replace_client',expect.any(AbortSignal),'cursor');
  });
  it('does not call selected apps connected when an existing credential is still needed',async()=>{
    const f=harness([]);f.conversation.preview.clients=['cursor'];
    const ui={signal:new AbortController().signal,answer:vi.fn(async()=>''),qr:vi.fn(),finish:vi.fn(),close:vi.fn(async()=>undefined)};f.conversation.loginUi=ui;
    expect(await runOwnerConversation(f.conversation)).toBe(0);expect(ui.finish).toHaveBeenCalledWith(true,[]);
  });
  it('announces the administrator password, elevates, then shows API guidance only when the worker asks for the application id', async () => {
    const { conversation, events, answers } = harness(['api_id', 'api_hash', 'phone']);
    expect(await runOwnerConversation(conversation)).toBe(0);
    const elevated = events.indexOf('elevate');
    expect(events.slice(0, elevated)).toEqual(elevationNotice('darwin').map(line => `err:${line}`));
    const guidance = events.indexOf(`err:${apiInstructions[0]}`);
    expect(guidance).toBeGreaterThan(elevated);
    expect(events.slice(guidance, guidance + apiInstructions.length)).toEqual(apiInstructions.map(line => `err:${line}`));
    expect(events.indexOf('hidden:Telegram application id: ')).toBeGreaterThan(guidance + apiInstructions.length);
    expect(events.filter(event => event === `err:${apiInstructions[0]}`)).toHaveLength(1);
    expect(events.filter(event => event.startsWith('hidden:'))).toEqual(['hidden:Telegram application id: ', 'hidden:Telegram application hash: ', 'hidden:Telegram phone (international format): ']);
    expect(answers.map(answer => (answer as { kind: string; sequence: number }).sequence)).toEqual([1, 2, 3]);
    expect(answers.every(answer => (answer as { kind: string }).kind === 'answer')).toBe(true);
  });
  it('never shows API guidance when saved credentials are used or elevation is refused', async () => {
    const saved = harness(['phone', 'code']);
    expect(await runOwnerConversation(saved.conversation)).toBe(0);
    expect(saved.events.some(event => apiInstructions.some(line => event === `err:${line}`))).toBe(false);
    const refused = harness(['api_id']);
    refused.conversation.elevate = async () => { refused.events.push('elevate'); throw new SetupError('protection_unverified'); };
    await expect(runOwnerConversation(refused.conversation)).rejects.toThrow('protection_unverified');
    expect(refused.events).toEqual([...elevationNotice('darwin').map(line => `err:${line}`), 'elevate']);
  });
  it('ends an unverified run with public evidence and the exact installed rerun command', async () => {
    const { conversation, events } = harness([]);
    expect(await runOwnerConversation(conversation)).toBe(0);
    const output = events.filter(event => event.startsWith('out:'));
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!.slice(4))).toMatchObject({ phase: 'needs_existing_client_credential', sdk_connectivity_verified: false, model_tool_loading_verified: false, clients: [] });
    expect(events.slice(-2)).toEqual(['err:No client connection was verified; existing state is kept. To connect a client, run this in an ordinary terminal and select one:', `err:${rerunCommand}`]);
    expect(events).toContain('closed');
  });
  it('pauses waiting feedback throughout hidden input, never echoes answers, and clears timers', async () => {
    vi.useFakeTimers();
    const { conversation, events, answers } = harness(['api_id', 'api_hash']);
    conversation.io.interactive = true;
    const elevate = conversation.elevate;
    conversation.elevate = async () => {
      const before = events.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toHaveLength(before);
      return elevate();
    };
    conversation.io.prompt = async () => {
      const before = events.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toHaveLength(before);
      return 'private-fixture-value';
    };
    expect(await runOwnerConversation(conversation)).toBe(0);
    expect(answers).toHaveLength(2);
    expect(events.join('\n')).not.toContain('private-fixture-value');
    expect(events.some(event => event.startsWith('out:'))).toBe(false);
    expect(events).toContain('err:Waiting for system approval and checking the installed gateway...');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears waiting feedback when system approval fails', async () => {
    vi.useFakeTimers();
    const { conversation } = harness([]); conversation.io.interactive = true;
    conversation.elevate = async () => { throw new SetupError('protection_unverified'); };
    await expect(runOwnerConversation(conversation)).rejects.toThrow('protection_unverified');
    expect(vi.getTimerCount()).toBe(0);
  });
});
