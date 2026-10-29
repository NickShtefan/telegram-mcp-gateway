import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { startOwnerGuide, browserOwnerLogin, type OwnerGuide } from '../ownerGuide.js';
import type { OwnerQuestion } from '../promptChannel.js';
import type { CliIo } from '../../cli/io.js';
import { PassThrough } from 'node:stream';
import { privateLines, sendPrivate } from '../promptChannel.js';
import { runOwnerAttempts } from '../ownerConversation.js';

const guides: OwnerGuide[] = [];
afterEach(async () => { for (const guide of guides.splice(0)) await guide.close(); });
async function fixture(timeoutMs?: number) {
  const guide = await startOwnerGuide(timeoutMs); guides.push(guide);
  const url = new URL(guide.url); const origin = url.origin;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Setup-Token': url.hash.slice(1) };
  const state = async () => (await fetch(origin + '/api/status', { headers })).json() as Promise<Record<string, unknown>>;
  const answer = (sequence: number, value: string) => fetch(origin + '/api/answer', { method: 'POST', headers, body: JSON.stringify({ sequence, value }) });
  return { guide, origin, headers, state, answer };
}

describe('temporary owner guide boundary', () => {
  it('leaves stdin to renewed system approval and rearms controls only after protected worker input resumes',async()=>{
    let privateUrl='';let active=false;let starts=0;let secondStarted!:()=>void;let approve!:()=>void;
    const waiting=new Promise<void>(resolve=>{secondStarted=resolve;});const approval=new Promise<void>(resolve=>{approve=resolve;});
    const controlEvents:string[]=[];
    const io:CliIo={out:()=>undefined,err:()=>undefined,prompt:async()=>{throw new Error('unexpected console input');},
      browserControl:()=>{expect(active).toBe(false);active=true;controlEvents.push('armed');return()=>{active=false;controlEvents.push('stopped');};}};
    const ui=browserOwnerLogin(io,async url=>{privateUrl=url;});
    const run=runOwnerAttempts({io,platform:'darwin',sha:'a'.repeat(40),
      preview:{setup_id:'123e4567-e89b-42d3-a456-426614174000',account:'personal',user:'owner',replace_session:false,rotate_token:false,clients:[],browser_login:true},
      rerunCommand:'fixture-owner setup',loginUi:ui,existingTokens:async()=>[],configure:async()=>undefined,probe:async()=>false,
      elevate:async()=>{
        expect(active).toBe(false);controlEvents.push('approval');
        if(++starts===2){secondStarted();await approval;expect(active).toBe(false);}
        const input=new PassThrough(),output=new PassThrough();
        const worker=(async()=>{
          const lines=privateLines(output)[Symbol.asyncIterator]();await sendPrivate(input,{kind:'profile',setup_id:'123e4567-e89b-42d3-a456-426614174000',port:4100});
          const plan=await lines.next();if(plan.done)return;controlEvents.push('profile');let sequence=0;
          for(const question of ['api_id','api_hash','login_method'] as const){
            await sendPrivate(input,{kind:'prompt',sequence:++sequence,question});const answer=await lines.next();if(answer.done)return;
          }
          if(starts===1)await sendPrivate(input,{kind:'qr',token:Buffer.from('synthetic pending QR').toString('base64url'),expires:2000000000});
          else await sendPrivate(input,{kind:'prompt',sequence:++sequence,question:'phone'});
          await lines.next();
        })();worker.catch(()=>undefined);
        return{input,output,closing:async()=>{output.end();await worker;input.end();return 1;}};
      }});
    const rejected=expect(run).rejects.toThrow('invalid_state');
    try{
      await vi.waitFor(()=>expect(privateUrl).not.toBe(''));
      const url=new URL(privateUrl);const headers={Origin:url.origin,'Content-Type':'application/json','X-Setup-Token':url.hash.slice(1)};
      const state=async()=>await(await fetch(url.origin+'/api/status',{headers})).json() as {sequence:number;question?:string;phase:string};
      const answer=async(value:string)=>fetch(url.origin+'/api/answer',{method:'POST',headers,body:JSON.stringify({sequence:(await state()).sequence,value})});
      await vi.waitFor(async()=>expect((await state()).question).toBe('api_id'));await answer('12345');
      await vi.waitFor(async()=>expect((await state()).question).toBe('api_hash'));await answer('a'.repeat(32));
      await vi.waitFor(async()=>expect((await state()).phase).toBe('qr'));expect(active).toBe(true);
      expect((await fetch(url.origin+'/api/method',{method:'POST',headers,body:JSON.stringify({method:'phone'})})).status).toBe(200);
      await waiting;expect(active).toBe(false);await new Promise(resolve=>setImmediate(resolve));expect(active).toBe(false);
      approve();await vi.waitFor(async()=>expect((await state()).question).toBe('phone'));expect(active).toBe(true);
      expect(controlEvents).toEqual(['approval','profile','armed','stopped','approval','profile','armed']);
      await fetch(url.origin+'/api/cancel',{method:'POST',headers,body:'{}'});await rejected;expect(active).toBe(false);
    }finally{approve();await ui.close();}
  });
  it('starts QR automatically, retains API values only in memory across method switches, and closes the listener for console',async()=>{
    let privateUrl='';let toConsole!:()=>void;const controlClosed=vi.fn();
    const io:CliIo={out:()=>undefined,err:()=>undefined,prompt:vi.fn(async()=>'+15551234567'),
      browserControl:callback=>{toConsole=callback;return controlClosed;}};
    const ui=browserOwnerLogin(io,async url=>{privateUrl=url;});
    const signal=new AbortController().signal;
    const id=ui.answer('api_id',signal);await vi.waitFor(()=>expect(privateUrl).not.toBe(''));
    const url=new URL(privateUrl);const headers={Origin:url.origin,'Content-Type':'application/json','X-Setup-Token':url.hash.slice(1)};
    const state=async()=>await (await fetch(url.origin+'/api/status',{headers})).json() as {sequence:number};
    const answer=async(value:string)=>fetch(url.origin+'/api/answer',{method:'POST',headers,body:JSON.stringify({sequence:(await state()).sequence,value})});
    await answer('12345');expect(await id).toBe('12345');
    const hash=ui.answer('api_hash',signal);await answer('a'.repeat(32));await hash;
    expect(await ui.answer('login_method',signal)).toBe('qr');
    ui.qr({token:Buffer.from('synthetic switch token').toString('base64url'),expires:2000000000});
    const switched=await fetch(url.origin+'/api/method',{method:'POST',headers,body:JSON.stringify({method:'phone'})});expect(switched.status).toBe(200);
    expect(ui.signal.aborted).toBe(true);expect(controlClosed).toHaveBeenCalledOnce();
    expect((await fetch(url.origin+'/api/method',{method:'POST',headers,body:JSON.stringify({method:'qr'})})).status).toBe(409);
    ui.finish(false);expect(await ui.takeRetry!()).toEqual({mode:'browser',method:'phone'});
    expect(await ui.answer('api_id',signal)).toBe('12345');expect(await ui.answer('api_hash',signal)).toBe('a'.repeat(32));
    expect(await ui.answer('login_method',signal)).toBe('phone');
    expect(JSON.stringify(await state())).not.toContain('a'.repeat(32));
    toConsole();expect(ui.signal.aborted).toBe(true);ui.finish(false);
    expect(await ui.takeRetry!()).toEqual({mode:'console',method:'phone'});
    await expect(fetch(url.origin)).rejects.toThrow();
    expect(await ui.answer('phone',signal)).toBe('+15551234567');await ui.close();
  });
  it('allows method changes only at authentication and requires capability, exact origin and a bounded method',async()=>{
    const changes=vi.fn();const guide=await startOwnerGuide(undefined,changes);guides.push(guide);
    const url=new URL(guide.url);const headers={Origin:url.origin,'Content-Type':'application/json','X-Setup-Token':url.hash.slice(1)};
    const change=(method:string,extraHeaders={})=>fetch(url.origin+'/api/method',{method:'POST',headers:{...headers,...extraHeaders},body:JSON.stringify({method})});
    expect((await change('phone')).status).toBe(409);guide.working();
    expect((await change('phone',{Origin:'https://invalid.example'})).status).toBe(403);
    expect((await change('invalid')).status).toBe(400);expect(changes).not.toHaveBeenCalled();
    const apps=guide.answer('clients',new AbortController().signal);
    expect((await change('phone')).status).toBe(409);guide.finish(false);await expect(apps).rejects.toThrow('invalid_state');
  });
  it('aborts console client selection after browser launch failure when the coordinator ends',async()=>{
    const life=new AbortController();let ready!:()=>void;const prompted=new Promise<void>(resolve=>{ready=resolve;});let received:AbortSignal|undefined;
    const io:CliIo={out:()=>undefined,err:()=>undefined,prompt:async(_question,options)=>new Promise((_resolve,reject)=>{
      received=options?.signal;options?.signal?.addEventListener('abort',()=>reject(new Error('fixture cancelled')),{once:true});ready();
    })};
    const ui=browserOwnerLogin(io,async()=>{throw new Error('fixture browser unavailable');});
    const pending=ui.answer('clients',life.signal);const rejected=expect(pending).rejects.toThrow('fixture cancelled');
    await prompted;expect(received).toBe(life.signal);life.abort();await rejected;await ui.close();
  });
  it('accepts only catalog app selections and scopes replacement to the named client',async()=>{
    const f=await fixture();const signal=new AbortController().signal;const pending=f.guide.answer('clients',signal);
    const sequence=Number((await f.state()).sequence);
    expect((await f.answer(sequence,'["unknown"]')).status).toBe(400);
    expect((await f.answer(sequence,'["cursor","cursor"]')).status).toBe(400);
    await f.answer(sequence,'["cursor","openclaw"]');expect(JSON.parse(await pending)).toEqual(['cursor','openclaw']);
    const replace=f.guide.answer('replace_client',signal,'cursor');expect(await f.state()).toMatchObject({question:'replace_client',client:'cursor'});
    await f.answer(Number((await f.state()).sequence),'REPLACE');expect(await replace).toBe('REPLACE');
    f.guide.finish(true,['cursor','openclaw']);expect(await f.state()).toMatchObject({phase:'complete',clients:['cursor','openclaw']});
  });
  it('serves the guide without credentials and requires the private capability, correct Host and same Origin for API access', async () => {
    const f = await fixture();
    const page = await fetch(f.origin); const html = await page.text();
    expect(page.status).toBe(200); expect(html).toContain('Create your Telegram app');
    expect(html).not.toContain(f.headers['X-Setup-Token']);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(f.origin + '/api/status')).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, 'X-Setup-Token': '0'.repeat(64) } })).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, 'X-Setup-Token': 'é'.repeat(64) } })).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, Origin: 'https://example.invalid' } })).status).toBe(403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      request(f.origin, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    expect(rebound).toBe(403);
    expect((await fetch(f.origin + '/api/answer', { method: 'OPTIONS', headers: f.headers })).status).toBe(403);
  });
  it('accepts each pending answer once, validates values and never returns submitted secrets', async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const pending = f.guide.answer('api_hash', signal); const state = await f.state();
    expect((await f.answer(Number(state.sequence), 'bad')).status).toBe(400);
    expect((await f.answer(Number(state.sequence) + 1, 'a'.repeat(32))).status).toBe(409);
    expect((await f.answer(Number(state.sequence), 'a'.repeat(32))).status).toBe(200);
    expect(await pending).toBe('a'.repeat(32));
    expect((await f.answer(Number(state.sequence), 'a'.repeat(32))).status).toBe(409);
    expect(JSON.stringify(await f.state())).not.toContain('a'.repeat(32));
    for (const [question, value] of [['api_id', '12345'], ['login_method', 'phone'], ['phone', '+15551234567'], ['code', '12345'], ['password', ' fixture password ']] as Array<[OwnerQuestion, string]>) {
      const input = f.guide.answer(question, signal);
      expect((await f.answer(Number((await f.state()).sequence), value)).status).toBe(200);
      expect(await input).toBe(value);
    }
  });
  it('renders refreshed QR tokens only on the private endpoint and clears them at the next prompt and completion', async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const method = f.guide.answer('login_method', signal);
    await f.answer(Number((await f.state()).sequence), 'qr'); await method;
    f.guide.qr({ token: Buffer.from('synthetic QR token one').toString('base64url'), expires: 2000000000 });
    const first = await f.state(); expect(first.phase).toBe('qr'); expect(first.qrImage).toMatch(/^data:image\/svg\+xml;base64,/);
    f.guide.qr({ token: Buffer.from('synthetic QR token two').toString('base64url'), expires: 2000000030 });
    const second = await f.state(); expect(second.qrImage).not.toBe(first.qrImage);
    const password = f.guide.answer('password', signal);
    expect((await f.state()).qrImage).toBeUndefined();
    await f.answer(Number((await f.state()).sequence), 'test-password'); await password;
    f.guide.finish(true); f.guide.finish(false);
    expect(await f.state()).toMatchObject({ phase: 'complete' });
  });
  it('rejects unexpected JSON, oversized input and cross-origin cancellation while preserving the pending question', async () => {
    const f = await fixture(); const pending = f.guide.answer('api_id', new AbortController().signal);
    const sequence = Number((await f.state()).sequence);
    expect((await fetch(f.origin + '/api/answer', { method: 'POST', headers: f.headers, body: JSON.stringify({ sequence, value: '12345', extra: true }) })).status).toBe(400);
    expect((await f.answer(sequence, 'x'.repeat(2200))).status).toBe(400);
    expect((await fetch(f.origin + '/api/cancel', { method: 'POST', headers: { ...f.headers, Origin: 'https://example.invalid' }, body: '{}' })).status).toBe(403);
    expect(f.guide.signal.aborted).toBe(false);
    await f.answer(sequence, '12345'); expect(await pending).toBe('12345');
  });
  it('cancels and expires pending input, and closes the listener', async () => {
    const f = await fixture(); const pending = f.guide.answer('code', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('invalid_state');
    await fetch(f.origin + '/api/cancel', { method: 'POST', headers: f.headers, body: '{}' });
    await rejected; expect(f.guide.signal.aborted).toBe(true); await f.guide.close();
    await expect(fetch(f.origin)).rejects.toThrow();
    const expires = await fixture(20); const input = expires.guide.answer('code', new AbortController().signal);
    await expect(input).rejects.toThrow('invalid_state'); expect(expires.guide.signal.aborted).toBe(true);
  });
  it('starts no listener until input is requested and falls back to console if browser launch fails', async () => {
    const opened = vi.fn(async () => { throw new Error('synthetic browser failure'); });
    const io = { out: vi.fn(), err: vi.fn(), prompt: vi.fn(async () => '12345') };
    const ui = browserOwnerLogin(io, opened);
    expect(opened).not.toHaveBeenCalled();
    expect(await ui.answer('api_id', new AbortController().signal)).toBe('12345');
    expect(await ui.answer('login_method', new AbortController().signal)).toBe('phone');
    expect(opened).toHaveBeenCalledTimes(1); expect(ui.signal.aborted).toBe(false);
    expect(JSON.stringify(io.err.mock.calls)).not.toContain('#'); await ui.close();
  });
});
