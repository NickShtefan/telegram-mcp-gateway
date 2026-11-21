import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';
import { classifyError, GatewayError } from '../../core/errors.js';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';
import { markupFor } from '../../services/specialPayload.js';

const chat='@fixture_channel', link='https://t.me/fixture_channel/42', initial=1_800_000_000;
const channel=rawChannel(500,{username:'fixture_channel'});
const pollText=(text:string)=>new Api.TextWithEntities({text,entities:[]});
function poll(closed=false,quiz=false) {
  return new Api.MessageMediaPoll({poll:new Api.Poll({id:bigInt(54),creator:true,closed,quiz,hash:bigInt(10),question:pollText('Which?'),
    answers:['A','B'].map((text,i)=>new Api.PollAnswer({text:pollText(text),option:Buffer.from([i])}))}),
    results:new Api.PollResults({totalVoters:3,solution:quiz?'Explanation':undefined,solutionEntities:quiz?[]:undefined})});
}
function decoded<R extends Api.messages.EditMessage>(request:R) {
  return new BinaryReader(request.getBytes()).tgReadObject() as R;
}
let gateway:TestGateway, client:TestClient, published:Record<string,unknown>, scheduled:Record<string,unknown>[];
let bot:boolean, premium:boolean, now:number;
const draft=(op:string,args={},target:Record<string,unknown>={link})=>client.call('tg_edit_post',{op,...target,...args});
const schedule=(args={})=>draft('edit_scheduled',args,{chat,id:42});
const confirm=(approval_id:unknown,action='approve')=>client.call('tg_confirm',{approval_id,action});
const options=(o:Record<string,unknown>)=>({special_options_json:JSON.stringify(o)});
const queueRead=(id?:number)=>client.call('tg_get_message',{chat,view:'scheduled',...(id!==undefined?{id}:{})});
function applied(req:Api.messages.EditMessage) {
  const send=decoded(req);
  if (send.scheduleDate) {
    const post=scheduled.find(p=>p.id===send.id)!;
    post.date=send.scheduleDate;
    post.scheduleRepeatPeriod=send.scheduleRepeatPeriod;
    if (send.message!==null && send.message!==undefined) post.message=send.message;
    if (send.entities) post.entities=send.entities;
  } else if (send.replyMarkup) {
    published.replyMarkup=send.replyMarkup;
  } else if (send.media?.className==='InputMediaPoll') {
    const original=published.media as Api.MessageMediaPoll;
    published.media=new Api.MessageMediaPoll({...original,poll:new Api.Poll({...original.poll,closed:true,hash:bigInt(88)})});
  } else {
    published.replyMarkup=undefined;
  }
  return {};
}

beforeEach(async()=>{
  now=initial;bot=false;premium=true;
  gateway=makeTestGateway({now:()=>now*1000});client=await gateway.client('user_a',['core','write']);
  published=rawMessage(500,42,{post:true,message:'Published',out:true,fromId:new Api.PeerUser({userId:bigInt(1001)})});
  scheduled=[rawMessage(500,42,{post:true,out:true,date:initial+3600,message:'Queued text',
    entities:[new Api.MessageEntityBold({offset:0,length:6})]})];
  gateway.tg.on('contacts.ResolveUsername',()=>({peer:{channelId:500n},chats:[channel]}));
  gateway.tg.on('channels.GetMessages',()=>({messages:[published],chats:[channel]}));
  gateway.tg.on('messages.GetScheduledHistory',()=>({messages:scheduled,chats:[channel]}));
  gateway.tg.on('messages.GetScheduledMessages',()=>({messages:scheduled,chats:[channel]}));
  gateway.tg.on('channels.GetParticipant',()=>({participant:{className:'ChannelParticipantCreator'}}));
  gateway.tg.on('users.GetUsers',()=>[new Api.User({id:bigInt(1001),bot,premium})]);
  gateway.tg.on('help.GetConfig',()=>({messageLengthMax:4096,captionLengthMax:1024}));
  gateway.tg.on('updates.GetState',()=>({date:now}));
  gateway.tg.on('messages.EditMessage',applied);
});
afterEach(async()=>{await client.close();gateway.cleanup();});

describe('scheduled channel entries',()=>{
  it('uses the queue for discovery, approval and read-back despite a colliding published ID',async()=>{
    expect((await queueRead()).structured).toMatchObject({view:'scheduled',total:1,items:[{id:42,preview:'Queued text'}]});
    const old=await queueRead(42);
    expect(old.structured).toMatchObject({namespace:'scheduled',available:true,schedule_date:initial+3600});
    const p=await schedule({replacement:'Edited text',entities_json:'[{"type":"bold","offset":0,"length":6}]',
      ...options({schedule_date:initial+7200,schedule_repeat_period:86400})});
    expect(p.structured,p.text).toMatchObject({op:'edit_scheduled',namespace:'scheduled',before:{value:'Queued text'},after:{value:'Edited text'}});
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    const result=await confirm(p.structured?.approval_id);
    expect(result.structured,result.text).toMatchObject({outcome:'verified',namespace:'scheduled',differences:[]});
    const req=decoded(gateway.tg.last('messages.EditMessage').request);
    expect(req.scheduleDate).toBe(initial+7200);
    expect(req.scheduleRepeatPeriod).toBe(86400);
    expect(req.entities?.[0]?.className).toBe('MessageEntityBold');
    expect(published.message).toBe('Published');
    expect(gateway.tg.callsOf('channels.GetMessages')).toHaveLength(0);
  });
  it('preserves caption and repeat on a date-only edit and does not resubmit text',async()=>{
    scheduled[0].scheduleRepeatPeriod=86400;
    const p=await schedule(options({schedule_date:initial+8000}));
    const r=await confirm(p.structured?.approval_id);
    expect(r.structured,r.text).toMatchObject({outcome:'verified'});
    const req=decoded(gateway.tg.last('messages.EditMessage').request);
    expect(req.message).toBeFalsy();
    expect(req.entities).toBeFalsy();
    expect(req.scheduleRepeatPeriod).toBe(86400);
    expect(scheduled[0].message).toBe('Queued text');
  });
  it('removes repetition using the one-time scheduled wire shape',async()=>{
    scheduled[0].scheduleRepeatPeriod=86400;
    const p=await schedule(options({schedule_repeat_period:null}));
    expect(p.structured?.after).toMatchObject({schedule_repeat_period:null,schedule_date:initial+3600});
    expect((await confirm(p.structured?.approval_id)).structured?.outcome).toBe('verified');
    const req=decoded(gateway.tg.last('messages.EditMessage').request);
    expect(req.scheduleDate).toBe(initial+3600);
    expect(req.scheduleRepeatPeriod).toBeFalsy();
  });
  it('refuses a video-processing queue entry',async()=>{
    scheduled[0].videoProcessingPending=true;
    expect((await schedule(options({schedule_date:initial+7200}))).text).toContain('processing video');
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it.each(['source','new-date','queue','rights','premium'])('refuses stale %s without a write or published fallback',async change=>{
    const p=await schedule(options({schedule_date:initial+(change==='new-date'?600:7200),schedule_repeat_period:86400}));
    expect(p.structured?.status).toBe('preview');
    if(change==='source')now=initial+3570;
    if(change==='new-date')now=initial+590;
    if(change==='queue')scheduled=[];
    if(change==='rights')gateway.tg.on('channels.GetParticipant',()=>({participant:{className:'ChannelParticipant'}}));
    if(change==='premium')premium=false;
    const r=await confirm(p.structured?.approval_id);
    expect(r.isError).toBe(true);
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    expect(gateway.tg.callsOf('channels.GetMessages')).toHaveLength(0);
  });
  it('rechecks the lead time inside the write lane',async()=>{
    const p=await schedule(options({schedule_date:initial+7200}));
    const real=gateway.tg.invoke.bind(gateway.tg);
    gateway.tg.invoke=async(account,request,opts)=>{
      if(request.className==='messages.EditMessage')now=initial+3590;
      return real(account,request,opts);
    };
    expect((await confirm(p.structured?.approval_id)).structured).toMatchObject({outcome:'conflict'});
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('rejects a schedule too near Telegram time even when the local clock lags',async()=>{
    const p=await schedule(options({schedule_date:initial+7200}));
    gateway.tg.on('updates.GetState',()=>({date:initial+3580}));
    expect((await confirm(p.structured?.approval_id)).structured?.outcome).toBe('conflict');
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('scopes discovery and rejects malformed addresses and immediate dates',async()=>{
    expect((await draft('edit_scheduled',options({schedule_date:initial+3600}))).isError).toBe(true);
    expect((await schedule(options({schedule_date:initial+8}))).isError).toBe(true);
    expect((await schedule(options({schedule_repeat_period:0}))).isError).toBe(true);
    scheduled.push(rawMessage(501,43,{post:true,date:initial+3600,message:'Other channel'}));
    expect((await queueRead()).structured?.total).toBe(1);
  });
  it('reconciles a lost response with a queue read and never repeats the mutation',async()=>{
    const p=await schedule(options({schedule_date:initial+7200}));
    let readsAllowed=true;
    gateway.tg.on('messages.GetScheduledMessages',()=>{
      if (!readsAllowed)throw new GatewayError('TIMEOUT','read failed');
      return {messages:scheduled};
    });
    gateway.tg.on('messages.EditMessage',req=>{
      applied(req);readsAllowed=false;
      throw new GatewayError('TIMEOUT','Reply lost',{outcomeUnknown:true});
    });
    const id=p.structured?.approval_id;
    expect((await confirm(id)).structured).toMatchObject({outcome:'outcome_unknown'});
    readsAllowed=true;
    expect((await confirm(id,'status')).structured).toMatchObject({outcome:'verified',namespace:'scheduled'});
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
});

describe('keyboards and special messages',()=>{
  const rows=[[{text:'Read',url:'https://example.org'}]];
  it('edits an outgoing broadcast post when Telegram omits its sender and refuses an incoming one',async()=>{
    bot=true;
    published.fromId=null;
    published.out=false;
    expect((await draft('edit_keyboard',options({rows}))).isError).toBe(true);
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    published.out=true;
    const p=await draft('edit_keyboard',options({rows}));
    expect(p.structured,p.text).toMatchObject({status:'preview',after:rows});
    expect((await confirm(p.structured?.approval_id)).structured).toMatchObject({outcome:'verified',differences:[]});
  });
  it('rechecks outgoing ownership on the last keyboard read before writing',async()=>{
    bot=true;
    published.fromId=null;
    gateway.tg.on('channels.GetMessages',()=>({messages:[{...published}],chats:[channel]}));
    const p=await draft('edit_keyboard',options({rows}));
    gateway.tg.on('channels.GetParticipant',()=>{
      published.out=false;
      return {participant:{className:'ChannelParticipantCreator'}};
    });
    expect((await confirm(p.structured?.approval_id)).structured).toMatchObject({outcome:'conflict'});
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('checks account type and authorship, then sets and clears only URL markup on the wire',async()=>{
    expect((await draft('edit_keyboard',options({rows}))).text).toContain('bot that authored');
    bot=true;
    published.fromId=new Api.PeerUser({userId:bigInt(999)});
    expect((await draft('edit_keyboard',options({rows}))).isError).toBe(true);
    published.fromId=new Api.PeerUser({userId:bigInt(1001)});
    for(const desired of [rows,[]]){
      const p=await draft('edit_keyboard',options({rows:desired}));
      expect(p.structured,p.text).toMatchObject({status:'preview',after:desired});
      expect((await confirm(p.structured?.approval_id)).structured?.outcome).toBe('verified');
      const req=decoded(gateway.tg.last('messages.EditMessage').request);
      if (desired.length) expect(req.replyMarkup?.className).toBe('ReplyInlineMarkup');
      else expect(req.replyMarkup).toBeFalsy();
      expect(req.message).toBeFalsy();
      expect(req.entities).toBeFalsy();
      expect(req.media).toBeFalsy();
    }
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(2);
  });
  it('distinguishes an explicit keyboard change and preserving markup during a content edit',async()=>{
    published.replyMarkup=markupFor(rows);
    expect((await draft('replace_content',{replacement:'Changed',entities_json:'[]'})).text).toContain('cannot preserve the existing keyboard');
    bot=true;
    const p=await draft('edit_keyboard',options({rows:[]}));
    published.replyMarkup=markupFor([[{text:'Other',url:'https://example.org'}]]);
    expect((await confirm(p.structured?.approval_id)).structured?.outcome).toBe('conflict');
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it.each([false,true])('closes a supported poll or quiz with minimal TL and preserves its definition (quiz=%s)',async quiz=>{
    published.media=poll(false,quiz);
    const p=await draft('close_poll');
    expect(p.structured,p.text).toMatchObject({status:'preview',before:{question:'Which?',closed:false,quiz}});
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    const result=await confirm(p.structured?.approval_id);
    expect(result.structured,result.text).toMatchObject({outcome:'verified',differences:[]});
    const wire=decoded(gateway.tg.last('messages.EditMessage').request);
    expect(wire.media).toMatchObject({className:'InputMediaPoll',poll:{closed:true,answers:[],question:{text:''}}});
    const again=await draft('close_poll');
    expect((await confirm(again.structured?.approval_id)).structured?.outcome).toBe('no-op');
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
  it('rejects paid, checklist and special polling operations with a distinct reason',async()=>{
    published.media=new Api.MessageMediaPaidMedia({starsAmount:bigInt(1),extendedMedia:[]});
    expect((await draft('close_poll')).isError).toBe(true);
    expect((await client.call('tg_get_message',{link,view:'special'})).structured?.reason).toMatch(/Paid media/);
    published.media=poll();
    expect((await draft('replace_range',{find:'Published',replacement:'Changed'})).text).toContain('Use close_poll');
    expect((await draft('close_poll',{text:'old'})).isError).toBe(true);
  });
  it('flags a changed quiz solution and ignores votes arriving during closure',async()=>{
    published.media=poll(false,true);
    const good=await draft('close_poll');
    gateway.tg.on('messages.EditMessage',req=>{
      applied(req);
      const m=published.media as Api.MessageMediaPoll;
      published.media=new Api.MessageMediaPoll({...m,results:new Api.PollResults({...m.results,totalVoters:4})});
      return {};
    });
    expect((await confirm(good.structured?.approval_id)).structured?.outcome).toBe('verified');
    published.media=poll(false,true);
    const bad=await draft('close_poll');
    gateway.tg.on('messages.EditMessage',req=>{
      applied(req);
      const m=published.media as Api.MessageMediaPoll;
      published.media=new Api.MessageMediaPoll({...m,results:new Api.PollResults({solution:'Changed',solutionEntities:[]})});
      return {};
    });
    expect((await confirm(bad.structured?.approval_id)).structured).toMatchObject({outcome:'conflict',differences:['poll_solution']});
  });
  it('returns the exact server refusal and avoids retrying',async()=>{
    published.media=poll();
    const p=await draft('close_poll');
    gateway.tg.on('messages.EditMessage',()=>{throw classifyError({errorMessage:'MESSAGE_AUTHOR_REQUIRED'},{write:true});});
    const id=p.structured?.approval_id;
    expect((await confirm(id)).structured).toMatchObject({outcome:'failed',telegram_code:'MESSAGE_AUTHOR_REQUIRED',code:'WRITE_FORBIDDEN'});
    await confirm(id);
    expect(gateway.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
});
