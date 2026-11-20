import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';
import bigInt from 'big-integer';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage } from '../../__tests__/helpers/fakeTg.js';
import { classifyError } from '../../core/errors.js';

const link = 'https://t.me/fixture_channel/42';
const first = 'https://alpha.example/one', second = 'https://beta.example/two';
const message = 'News ' + first + ' Guide';
const entityList = () => [
  new Api.MessageEntityUrl({ offset:5, length:first.length }),
  new Api.MessageEntityBold({ offset:message.indexOf('Guide'), length:5 }),
  new Api.MessageEntityTextUrl({ offset:message.indexOf('Guide'), length:5, url:second }),
];
function page(url: string, options: {manual?: boolean; small?: boolean; large?: boolean; resizable?: boolean; title?: string; id?: number} = {}) {
  return new Api.MessageMediaWebPage({ manual:options.manual, forceSmallMedia:options.small, forceLargeMedia:options.large,
    webpage:new Api.WebPage({ id:bigInt(options.id ?? 1), hash:0, url, displayUrl:url,
      title:options.title, hasLargeMedia:options.resizable ?? true }) });
}
let gw: TestGateway;
let client: TestClient;
let post: Record<string,unknown>;
const draft = (args = {}) => client.call('tg_edit_post',{link, op:'set_link_preview', ...args});
const inspect = () => client.call('tg_get_message',{link,view:'preview'});
const confirm = (approval_id: unknown, args = {}) => client.call('tg_confirm',{approval_id,...args});
async function prepared(args = {}) {
  const p = await draft(args);
  expect(p.structured?.status,p.text).toBe('preview');
  return p.structured!.approval_id;
}
beforeEach(async () => {
  gw = makeTestGateway();
  client = await gw.client('user_a',['core','write']);
  const channel = rawChannel(500,{username:'fixture_channel'});
  post = rawMessage(500,42,{post:true,message,entities:entityList()});
  gw.tg.on('contacts.ResolveUsername',()=>({peer:{channelId:500n},chats:[channel]}));
  gw.tg.on('channels.GetMessages',()=>({messages:[post],chats:[channel]}));
  gw.tg.on('channels.GetParticipant',()=>({participant:{className:'ChannelParticipantCreator'}}));
  gw.tg.on('help.GetConfig',()=>({messageLengthMax:4096,captionLengthMax:1024}));
  gw.tg.on('messages.GetWebPagePreview',req=>({media:page(req.message.startsWith('https://') ? req.message : first)}));
  gw.tg.on('messages.EditMessage',req=>{
    const sent = new BinaryReader(req.getBytes()).tgReadObject();
    post.message = sent.message; post.entities = sent.entities; post.invertMedia = !!sent.invertMedia;
    post.media = sent.noWebpage ? undefined : sent.media ? page(sent.media.url,{manual:true,large:sent.media.forceLargeMedia,small:sent.media.forceSmallMedia}) : page(first);
    return {};
  });
});
afterEach(async()=>{await client.close();gw.cleanup()});

describe('channel link preview settings',()=>{
  it('selects one URL on a multi-link post, shows the full change, and preserves entities on the wire',async()=>{
    expect((await inspect()).structured).toMatchObject({view:'preview',card:{kind:'off'},candidates:[first,second]});
    expect((await draft({preview_mode:'enable'})).structured).toMatchObject({status:'choose_url',candidates:[first,second]});
    expect(gw.services.writeGate.store.listApprovals('user_a',['pending'])).toEqual([]);
    const p = await draft({preview_url:second,preview_size:'large',preview_position:'top'});
    expect(p.structured).toMatchObject({op:'set_link_preview',status:'preview',before:null,
      after:{url:second,size:'large',position:'top',manual:true},selected_url:second});
    const id = p.structured!.approval_id;
    expect((await confirm(id,{text:'replacement'})).isError).toBe(true);
    expect((await confirm(id,{action:'status'})).structured?.state).toBe('pending');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
    expect((await confirm(id)).structured).toMatchObject({outcome:'verified',differences:[]});
    const req=gw.tg.last('messages.EditMessage').request;
    const decoded=new BinaryReader(req.getBytes()).tgReadObject();
    expect(decoded.media).toMatchObject({className:'InputMediaWebPage',url:second,forceLargeMedia:true});
    expect(decoded.media.optional).toBeFalsy();
    expect(decoded.message).toBe(message);
    expect(decoded.entities.map((e:Api.TypeMessageEntity)=>e.getBytes())).toEqual(entityList().map(e=>e.getBytes()));
    expect(decoded.invertMedia).toBe(true);
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
  it('disables a top card and preserves a disabled post without another edit or card lookup',async()=>{
    post.media=page(second,{manual:true,small:true});post.invertMedia=true;
    const id=await prepared({preview_mode:'disable'});
    expect((await confirm(id)).structured?.outcome).toBe('verified');
    const sent=gw.tg.last('messages.EditMessage').request;
    expect(sent.noWebpage).toBe(true);expect(sent.media).toBeUndefined();expect(sent.invertMedia).toBeUndefined();
    expect((await confirm(await prepared({preview_mode:'preserve'}))).structured?.outcome).toBe('no-op');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
  });
  it('keeps a manual target through an unrelated rich edit, ignoring external card content refresh',async()=>{
    post.media=page(second,{manual:true,small:true,title:'before'});post.invertMedia=true;
    const p=await client.call('tg_edit_post',{link,op:'replace_range',find:'News',replacement:'Bulletin'});
    expect(p.structured,p.text).toMatchObject({preserved_preview:{url:second,size:'small',position:'top',manual:true}});
    post.media=page(second,{manual:true,small:true,title:'updated remotely',id:8});
    expect((await confirm(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    const sent=gw.tg.last('messages.EditMessage').request;
    expect(sent.media).toMatchObject({url:second,forceSmallMedia:true});expect(sent.invertMedia).toBe(true);
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
  });
  it('keeps automatic previews automatic for position-only and decorative formatting changes',async()=>{
    post.media=page(first);
    post.entities=entityList().slice(0,2);
    const top=await prepared({preview_position:'top'});
    expect((await confirm(top)).structured?.outcome).toBe('verified');
    const formatted=await client.call('tg_edit_post',{link,op:'add_format',find:'News',style:'italic'});
    expect((await confirm(formatted.structured!.approval_id)).structured?.outcome).toBe('verified');
    for(const {request} of gw.tg.callsOf('messages.EditMessage')){
      expect(request.media).toBeUndefined();expect(request.noWebpage).toBeUndefined();expect(request.invertMedia).toBe(true);
    }
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
  });
  it('checks automatic selection on changed text and refuses an unexpected reselection before writing',async()=>{
    post.media=page(first);
    const edit=()=>client.call('tg_edit_post',{link,op:'replace_range',find:'News',replacement:'New'});
    const p=await edit();expect(p.structured?.status,p.text).toBe('preview');
    gw.tg.on('messages.GetWebPagePreview',()=>({media:page(second)}));
    expect((await confirm(p.structured!.approval_id)).structured?.outcome).toBe('failed');
    expect((await edit()).isError).toBe(true);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('resizes a card, returns to default size, and can move it to the bottom',async()=>{
    post.media=page(first);
    const p=await draft({preview_size:'small',preview_position:'top'});
    expect(p.structured).toMatchObject({before:{manual:false},after:{manual:true,size:'small',position:'top'}});
    expect((await confirm(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    const reset=await prepared({preview_size:'auto',preview_position:'bottom'});
    expect((await confirm(reset)).structured?.outcome).toBe('verified');
    const req=gw.tg.last('messages.EditMessage').request;
    expect(req.media.forceSmallMedia).toBeUndefined();expect(req.media.forceLargeMedia).toBeUndefined();
    expect(req.invertMedia).toBeUndefined();
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
  });
  it('refuses an unavailable URL, a redirect, incompatible sizes and capability changes at confirmation',async()=>{
    const edits=()=>gw.tg.callsOf('messages.EditMessage');
    gw.tg.on('messages.GetWebPagePreview',()=>({media:new Api.MessageMediaEmpty()}));
    expect((await draft({preview_url:second})).isError).toBe(true);
    gw.tg.on('messages.GetWebPagePreview',()=>({media:page(first)}));
    const redirected=await draft({preview_url:second});
    expect(redirected.isError).toBe(true);
    expect(redirected.structured).toMatchObject({status:'canonical_url_required',requested_url:second,resolved_url:first});
    post.media=page(first,{resizable:false});
    expect((await draft({preview_size:'small'})).isError).toBe(true);
    post.media=page(first);
    const id=await prepared({preview_size:'large'});post.media=page(first,{resizable:false});
    expect((await confirm(id)).isError).toBe(true);
    expect(edits()).toHaveLength(0);
  });
  it('detects stale preview settings and reports ignored Telegram fields in read-back',async()=>{
    post.media=page(first,{manual:true});
    const stale=await prepared({preview_position:'top'});
    post.media=page(first,{manual:true,small:true});
    expect((await confirm(stale)).structured?.outcome).toBe('conflict');
    const id=await prepared({preview_size:'large',preview_position:'top'});
    gw.tg.on('messages.EditMessage',()=>({}));
    const out=await confirm(id);
    expect(out.structured).toMatchObject({outcome:'conflict',differences:expect.arrayContaining(['preview_size','invert_media'])});
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });
  it('rejects incomplete post shapes, invalid URL and cross-operation arguments',async()=>{
    for(const args of [{preview_url:'tg://resolve?domain=x'},{preview_mode:'disable',preview_position:'top'},{preview_size:'small'},
      {preview_mode:'enable',link_preview:true},{preview_mode:'disable',text:'legacy'},{find:'News',preview_url:first}]){
      expect((await draft(args)).isError).toBe(true);
    }
    expect((await client.call('tg_edit_post',{link,text:'legacy',preview_url:first})).isError).toBe(true);
    expect((await client.call('tg_edit_post',{link,op:'replace_range',find:'News',replacement:'X',preview_size:'small'})).isError).toBe(true);
    for(const media of [new Api.MessageMediaPhoto({}),new Api.MessageMediaWebPage({webpage:new Api.WebPagePending({id:bigInt(1),date:123})})]){
      post.media=media;
      expect((await inspect()).structured?.available).toBe(false);
      expect((await draft({preview_mode:'enable'})).isError).toBe(true);
    }
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });
  it('reconciles a pending read-back with read-only status and never resubmits',async()=>{
    const id=await prepared({preview_url:second});
    gw.tg.on('messages.EditMessage',()=>{post.media=new Api.MessageMediaWebPage({webpage:new Api.WebPagePending({id:bigInt(2),date:123})});return {}});
    expect((await confirm(id)).structured).toMatchObject({outcome:'outcome_unknown',read_error:'WEBPAGE_PENDING'});
    post.media=page(second,{manual:true});
    expect((await confirm(id,{action:'status'})).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('preserves a single automatic card on an unrelated word edit without fetching or setting media',async()=>{
    post.media=page(first);
    post.entities=entityList().slice(0,1);
    const p=await client.call('tg_edit_post',{link,op:'replace_range',find:'News',replacement:'Bulletin'});
    expect(p.structured?.status,p.text).toBe('preview');
    expect((await confirm(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
    expect(gw.tg.last('messages.EditMessage').request.media).toBeUndefined();
  });

  it('refuses to move an automatic card when Telegram would pick another link from the same text',async()=>{
    post.media=page(second);
    const p=await draft({preview_position:'top'});
    expect(p.isError).toBe(true);
    expect(gw.services.writeGate.store.listApprovals('user_a',['pending'])).toEqual([]);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('preserves a manual card when changing a hidden destination',async()=>{
    post.media=page(first,{manual:true,small:true});
    const p=await client.call('tg_edit_post',{link,op:'replace_link_url',old_url:second,new_url:second+'/new'});
    expect(p.structured?.preserved_preview).toMatchObject({url:first,size:'small'});
    expect((await confirm(p.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(gw.tg.last('messages.EditMessage').request.media).toMatchObject({url:first,forceSmallMedia:true});
    expect(gw.tg.callsOf('messages.GetWebPagePreview')).toHaveLength(0);
  });

  it('rechecks URL resolution and access before mutating',async()=>{
    const id=await prepared({preview_url:second});
    gw.tg.on('messages.GetWebPagePreview',()=>({media:page(first)}));
    expect((await confirm(id)).structured?.outcome).toBe('conflict');
    gw.tg.on('messages.GetWebPagePreview',()=>{
      gw.storage.accounts.revoke('agent','user_a');
      return {media:page(second)};
    });
    expect((await draft({preview_url:second})).text).toContain('ACCESS_DENIED');
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(0);
  });

  it('offers a single inferred link and an explicit external URL without changing post text',async()=>{
    post.entities=[entityList()[0]];
    const inferred=await draft({preview_mode:'enable'});
    expect(inferred.structured).toMatchObject({status:'preview',after:{url:first,manual:true}});
    expect((await confirm(inferred.structured!.approval_id,{action:'reject'})).text).toContain('rejected');
    const outside='https://outside.example/page';
    const explicit=await draft({preview_url:outside});
    expect(explicit.structured).toMatchObject({after:{url:outside},selected_url:outside});
    expect((await confirm(explicit.structured!.approval_id)).structured?.outcome).toBe('verified');
    expect(post.message).toBe(message);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
  });

  it('keeps read-only inspection available and reports Telegram embedding refusals without a fallback',async()=>{
    const readOnly=await gw.client('user_a',['core']);
    try {
      expect((await readOnly.call('tg_get_message',{link,view:'preview'})).structured)
        .toMatchObject({available:false,code:'ACCESS_DENIED',card:{kind:'off'}});
    } finally { await readOnly.close(); }
    const id=await prepared({preview_url:first});
    gw.tg.on('messages.EditMessage',()=>{throw classifyError({errorMessage:'CHAT_SEND_WEBPAGE_FORBIDDEN'},{write:true})});
    expect((await confirm(id)).structured).toMatchObject({outcome:'failed',code:'WRITE_FORBIDDEN'});
    await confirm(id);
    expect(gw.tg.callsOf('messages.EditMessage')).toHaveLength(1);
    gw.tg.on('messages.GetWebPagePreview',()=>{throw classifyError({errorMessage:'WEBPAGE_NOT_FOUND'})});
    expect((await draft({preview_url:second})).text).toContain('could not generate');
    expect(gw.services.writeGate.store.listApprovals('user_a',['pending'])).toEqual([]);
  });
});
