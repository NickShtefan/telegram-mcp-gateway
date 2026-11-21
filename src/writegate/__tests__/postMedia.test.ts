import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { protectWindowsFixture } from '../../__tests__/helpers/windowsFiles.js';
import { join } from 'node:path';
import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';
import bigInt from 'big-integer';
import { toBotApiChatId } from '../../core/chatId.js';
import { GatewayError } from '../../core/errors.js';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';

const channel = rawChannel(500,{username:'fixture_channel'});
const link = 'https://t.me/fixture_channel/42', source = 'https://t.me/fixture_channel/44';
const photo = (id: number, ref = 'fresh', spoiler = false) => new Api.MessageMediaPhoto({spoiler,
  photo:new Api.Photo({id:bigInt(id),accessHash:bigInt(500),fileReference:Buffer.from(ref),date:1,dcId:1,sizes:[]})});
function document(id: number, name: string, size: number, video = false) {
  const attributes: Api.TypeDocumentAttribute[] = [new Api.DocumentAttributeFilename({fileName:name})];
  if (video) attributes.push(new Api.DocumentAttributeVideo({duration:8,w:10,h:10}));
  return new Api.MessageMediaDocument({video,document:new Api.Document({id:bigInt(id),accessHash:bigInt(11),fileReference:Buffer.from('doc'),
    date:1,dcId:1,size:bigInt(size),mimeType:video?'video/mp4':'application/octet-stream',attributes})});
}
let gw: TestGateway, client: TestClient;
let posts: Record<number,Record<string,unknown>>;
const draft = (args = {}) => client.call('tg_edit_post',{link,op:'replace_media',...args});
const confirm = (approval_id: unknown, action = 'approve') => client.call('tg_confirm',{approval_id,action});
async function preview(args = {}) {
  const r = await draft(args);
  expect(r.structured?.status,r.text).toBe('preview');
  return r.structured!.approval_id;
}
function apply(req: Api.messages.EditMessage) {
  const sent = new BinaryReader(req.getBytes()).tgReadObject() as Api.messages.EditMessage;
  expect(sent.message).toBeFalsy(); expect(sent.entities).toBeFalsy();
  const media=sent.media!;
  if (media.className === 'InputMediaPhoto' && media.id.className === 'InputPhoto') posts[42].media=photo(media.id.id.toJSNumber(),'received',media.spoiler);
  else if (media.className === 'InputMediaDocument' && media.id.className === 'InputDocument') {
    const current = Object.values(posts).map(p=>p.media as Api.TypeMessageMedia)
      .find(m=>m.className==='MessageMediaDocument' && m.document?.id.equals((media.id as Api.InputDocument).id));
    if (current?.className !== 'MessageMediaDocument') throw Error('Unknown fixture document');
    const cover=media.videoCover?.className === 'InputPhoto' ? photo(media.videoCover.id.toJSNumber()).photo : undefined;
    posts[42].media=new Api.MessageMediaDocument({...current,spoiler:media.spoiler,videoCover:cover,videoTimestamp:media.videoTimestamp});
  }
  return {};
}
beforeEach(async()=>{
  gw=makeTestGateway(); client=await gw.client('user_a',['core','write']);
  posts=Object.fromEntries([42,43,44].map(id=>[id,rawMessage(500,id,{post:true,message:id===42?'Caption':'Other',
    entities:id===42?[new Api.MessageEntityBold({offset:0,length:7})]:[],media:photo(id)})]));
  gw.tg.on('contacts.ResolveUsername',()=>({peer:{channelId:500n},chats:[channel]}));
  gw.tg.on('channels.GetMessages',req=>({messages:req.id.map((i:Api.InputMessageID)=>posts[i.id]).filter(Boolean),chats:[channel]}));
  gw.tg.on('messages.GetHistory',()=>({messages:Object.values(posts),chats:[channel]}));
  gw.tg.on('channels.GetParticipant',()=>({participant:{className:'ChannelParticipantCreator'}}));
  gw.tg.on('messages.EditMessage',apply);
});
afterEach(async()=>{await client.close();gw.cleanup();});

describe('conditional channel media edits',()=>{
  it('replaces one album item without resubmitting captions; verifies every item',async()=>{
    posts[42].groupedId=posts[43].groupedId=bigInt(99);
    const view=await client.call('tg_get_message',{link,view:'media'});
    expect(view.structured).toMatchObject({available:true,items:[42,43]});
    const id=await preview({media_source:source});
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    expect((await confirm(id)).structured).toMatchObject({state:'executed',outcome:'verified',differences:[],items:[{id:42,differences:[]},{id:43,differences:[]}]});
    await confirm(id);expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
    expect(posts[42].message).toBe('Caption');expect(posts[43].message).toBe('Other');
  });
  it.each(['target','sibling','source'])('refuses a stale %s before writing',async part=>{
    posts[42].groupedId=posts[43].groupedId=bigInt(5);
    const id=await preview({media_source:source});
    if(part==='source') posts[44].media=photo(999);
    else posts[part==='target'?42:43].message='Changed';
    expect((await confirm(id)).structured?.outcome).toBe('conflict');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('reports a collateral caption change on a sibling',async()=>{
    posts[42].groupedId=posts[43].groupedId=bigInt(12);
    const id=await preview({media_source:source});
    gw.tg.on('messages.EditMessage',req=>{apply(req);posts[43].message='Changed';return {};});
    expect((await confirm(id)).structured).toMatchObject({outcome:'conflict',items:[{id:42,differences:[]},{id:43,differences:['revision']}]});
  });
  it.each(['FILE_REFERENCE_EXPIRED','FILE_REFERENCE_INVALID'])('refreshes the original attachment once on %s',async code=>{
    const id=await preview({media_options_json:'{"spoiler":true}'});
    const seen: string[]=[];
    gw.tg.on('messages.EditMessage',req=>{
      seen.push(req.media.id.fileReference.toString());
      if(seen.length===1){posts[42].media=photo(42,'renewed');throw new GatewayError('TELEGRAM_ERROR','expired',{telegramCode:code});}
      return apply(req);
    });
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    expect(seen).toEqual(['fresh','renewed']);
  });
  it('will not use a changed source after an expired reference',async()=>{
    const id=await preview({media_source:source});
    gw.tg.on('messages.EditMessage',()=>{posts[44].media=photo(900);throw new GatewayError('TELEGRAM_ERROR','expired',{telegramCode:'FILE_REFERENCE_EXPIRED'});});
    expect((await confirm(id)).structured?.outcome).toBe('conflict');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
  it('reconciles a lost reply with a read, including after recovery',async()=>{
    const id=String(await preview({media_source:source}));
    gw.tg.on('messages.EditMessage',req=>{apply(req);throw new GatewayError('TIMEOUT','reply lost',{outcomeUnknown:true});});
    expect((await confirm(id)).structured).toMatchObject({outcome:'verified',rpc_evidence:'unknown'});
    gw.services.writeGate.store.updateApproval(id,{state:'executing',result:null});
    gw.services.writeGate.approvals.recover();
    expect((await confirm(id,'status')).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
  function stageDocument() {
    if (process.platform === 'win32') protectWindowsFixture(gw.home,false);
    const dir=join(gw.home,'uploads','user_a','agent');
    mkdirSync(dir,{recursive:true,mode:0o700});
    const path=join(dir,'note.txt');
    writeFileSync(path,'original',{mode:0o600});
    return path;
  }
  it('binds upload bytes before consent and stops if the staged file changes',async()=>{
    const path=stageDocument();
    const id=await preview({media_source:'upload:note.txt'});
    expect(gw.tg.callsOf('upload.SaveFilePart')).toHaveLength(0);
    writeFileSync(path,'modified');
    expect((await confirm(id)).structured?.outcome).toBe('conflict');
    expect(gw.tg.callsOf('upload.SaveFilePart')).toHaveLength(0);
  }, 120_000);
  it('checks the server-assigned identity of the approved upload',async()=>{
    stageDocument();
    const id=await preview({media_source:'upload:note.txt',media_options_json:'{"filename":"new.txt"}'});
    gw.tg.on('upload.SaveFilePart',req=>{expect(req.bytes.toString()).toBe('original');return true;});
    gw.tg.on('messages.UploadMedia',()=>{posts[44].media=document(701,'new.txt',8);return posts[44].media;});
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  }, 120_000);
  it.runIf(process.platform === 'win32')('refuses a file that gives Users read access inside a private inbox',async()=>{
    const path=stageDocument();
    execFileSync('C:\\Windows\\System32\\icacls.exe',[path,'/grant','*S-1-5-32-545:(R)'],{stdio:'ignore',timeout:30_000});
    expect((await draft({media_source:'upload:note.txt'})).text).toContain('upload ACL is not private');
    expect(gw.tg.callsOf('upload.SaveFilePart')).toHaveLength(0);
  }, 120_000);
  it('supports video cover and timestamp, checks protected sources and document album rules',async()=>{
    posts[42].media=document(42,'clip.mp4',100,true);
    const id=await preview({media_options_json:JSON.stringify({cover:source,timestamp:3,spoiler:true})});
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    expect((await client.call('tg_get_message',{link,view:'media'})).structured?.media).toMatchObject({cover:'44',timestamp:3,spoiler:true});
    expect((await confirm(await preview({media_options_json:'{"cover":"clear","timestamp":null,"spoiler":false}'}))).structured?.outcome).toBe('verified');
    posts[44].noforwards=true;
    expect((await draft({media_source:source})).isError).toBe(true);
    posts[44].noforwards=false;posts[44].media=document(44,'a.bin',5);
    posts[42].groupedId=posts[43].groupedId=bigInt(22);
    expect((await draft({media_source:source})).isError).toBe(true);
  });
  it('rejects mixed legacy fields, unsafe handles, and unsupported variants before approval',async()=>{
    for(const args of [{text:'replacement'},{old_url:source},{preview_mode:'enable'},{media_source:'upload:../token'},
      {media_options_json:'{"filename":"new"}'},{media_options_json:'{"unknown":true}'}]) expect((await draft(args)).isError).toBe(true);
    const v=document(44,'clip.mp4',8,true);
    posts[44].media=new Api.MessageMediaDocument({...v,altDocuments:[v.document!]});
    expect((await draft({media_source:source})).isError).toBe(true);
    expect(gw.services.writeGate.store.listApprovals('user_a',['pending'])).toHaveLength(0);
  });
});

describe('read-back and wire compatibility',()=>{
  const decoded = <T extends Api.TypeMessageMedia>(value:T) => new BinaryReader(value.getBytes()).tgReadObject() as T;
  it('accepts absent TL flags on real photo and document bytes and rejects expiring media',async()=>{
    posts[42].media=decoded(photo(42));
    posts[44].media=decoded(document(44,'file',8));
    expect((await confirm(await preview({media_source:source}))).structured?.outcome).toBe('verified');
    posts[44].media=decoded(new Api.MessageMediaPhoto({...photo(44),ttlSeconds:7}));
    expect((await draft({media_source:source})).isError).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('refuses public inboxes, public files and hardlinked upload handles',async()=>{
    const folder=join(gw.home,'uploads','user_a','agent');
    mkdirSync(folder,{recursive:true,mode:0o700});
    const path=join(folder,'note.txt');
    writeFileSync(path,'private',{mode:0o644});chmodSync(path,0o644);
    const args={media_source:'upload:note.txt'};
    expect((await draft(args)).isError).toBe(true);
    chmodSync(path,0o600);chmodSync(folder,0o755);
    expect((await draft(args)).isError).toBe(true);
    chmodSync(folder,0o700);linkSync(path,join(folder,'other'));
    expect((await draft(args)).isError).toBe(true);
    expect(gw.tg.callsOf('upload.SaveFilePart')).toHaveLength(0);
  });
  it('keeps the actual video flag for an unchanged video document',async()=>{
    posts[42].media=decoded(new Api.MessageMediaDocument({...document(42,'clip.mp4',20,true),video:undefined}));
    expect((await confirm(await preview({media_options_json:'{"spoiler":false}'}))).structured?.outcome).toBe('no-op');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('uses the latest album membership even if the sibling disappears between the two verification reads',async()=>{
    posts[42].groupedId=posts[43].groupedId=bigInt(70);
    const id=await preview({media_source:source});
    gw.tg.on('messages.EditMessage',req=>{
      apply(req);
      gw.tg.on('messages.GetHistory',()=>{delete posts[43];return {messages:Object.values(posts),chats:[channel]};});
      return {};
    });
    expect((await confirm(id)).structured).toMatchObject({outcome:'conflict',differences:['item[43].missing']});
  });
  it('reports the selected item disappearing after Telegram acknowledged the edit',async()=>{
    const id=await preview({media_source:source});
    gw.tg.on('messages.EditMessage',()=>{delete posts[42];return {};});
    expect((await confirm(id)).structured).toMatchObject({outcome:'conflict',items:[{id:42,differences:['missing']}]});
  });
  it('recovers an interrupted preflight as a definite failure before an edit was issued',async()=>{
    const id=String(await preview({media_source:source}));
    const {store,approvals}=gw.services.writeGate;
    store.updateApproval(id,{state:'executing'});
    approvals.recover();
    expect((await confirm(id,'status')).structured).toMatchObject({outcome:'failed'});
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('rechecks channel copying protection after source resolution and before editing',async()=>{
    const id=await preview({media_source:source});
    let checks = 0;
    gw.tg.on('channels.GetParticipant',()=>{
      if (++checks === 2) {
        const copied=gw.storage.entities.get('agent',toBotApiChatId(500))!;
        gw.storage.entities.putMany([{...copied,meta:{...copied.meta,noforwards:true}}]);
      }
      return {participant:{className:'ChannelParticipantCreator'}};
    });
    const result=await confirm(id);
    expect(checks).toBe(2);
    expect(result.structured).toMatchObject({outcome:'failed', code:'INVALID_ARGUMENT',
      message:expect.stringContaining('source channel disallows copying')});
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
});
