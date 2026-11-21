import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { sha256Hex } from '../core/crypto.js';
import { peerKeyOfPeer, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import type { WriteStore } from '../writegate/store.js';
import { prepareContent } from './contentEdit.js';
import { differences, entityFingerprints, isCaption, postEditState, semanticFields, unsupported, type PostEditState, type PostTarget, type PublishedPost } from './linkEdit.js';
import { coverageEntities, describeEntity, type Span } from './postEntities.js';
import { closeMedia, invalid, keyboardRows, markupFor, pollOn, specialFields, specialRefusal, stale,
  type ButtonRows, type Options, type SpecialFields, type SpecialOp } from './specialPayload.js';
import type { WriteService } from './write.js';

// Telegram may send immediately inside 10 seconds. Leave time for the account deadline and transport.
const minimumLeadSeconds = 60;
type Evidence = 'unknown' | 'acknowledged' | 'not_modified' | 'already_matched';
type Patch = { value:string; spans:Span[] };
type Schedule = { date:number; repeat:number | null };
export type SpecialPlan = PostTarget & {
  version:1; actor:string; revision:string; expected:SpecialFields;
} & (
  { op:'edit_scheduled'; schedule:Schedule; patch?:Patch } |
  { op:'edit_keyboard'; rows:ButtonRows } |
  { op:'close_poll' }
);
interface Request { op:SpecialOp; options:Options; replacement?:string; entities_json?:string }
interface Dependencies {
  write:WriteService; tg:Tg; store:WriteStore; now:()=>number;
  chat(user:string,target:Omit<PostTarget,'postId'>):EntityRecord;
}

function snapshot(state:PostEditState, editedContent = false, fields = state.fields) {
  const source = editedContent ? {...fields,entities:entityFingerprints(coverageEntities(state.post.entities ?? []))} : fields;
  return specialFields(state.post,source);
}

function revision(state:PostEditState) {
  return sha256Hex(JSON.stringify([state.revision,state.post.date,snapshot(state)]));
}

function ordinary(post:PublishedPost, keyboardChange = false) {
  if (post.factcheck || post.groupedId || post.replyTo?.replyMedia || post.suggestedPost ||
      post.viaBotId || post.ttlPeriod || post.richMessage) invalid('This post contains fields outside the supported edit matrix.');
  if (!keyboardChange && post.replyMarkup) invalid(specialRefusal(post)!);
}

function scheduledContentDenial(state:PostEditState) {
  if (!isCaption(state.post) && state.card.kind!=='off') return 'Scheduled text edits with link cards are unsupported.';
  if ((state.post.entities??[]).some(e=>e.className==='MessageEntityMentionName')) return 'Scheduled edits cannot safely preserve account-bound mentions.';
  return unsupported(state.post,true,state.card,state.fields.attachment,true);
}

export class SpecialPostService {
  constructor(private readonly deps:Dependencies) {}

  private channel(user:string,target:Omit<PostTarget,'postId'>) {
    const chat=this.deps.chat(user,target);
    if (chat.kind !== 'channel' || chat.meta.broadcast !== true) invalid('Choose a broadcast channel.');
    return chat;
  }

  private lead(date:number, now = Math.floor(this.deps.now()/1000)) {
    if (!Number.isSafeInteger(date) || date >= 2147483646 || date - now < minimumLeadSeconds) {
      stale('The queue time is too near, elapsed or unsupported. Both dates need at least 60 seconds of lead time.');
    }
  }

  private async queue(user:string,target:Omit<PostTarget,'postId'>,actor:string,id?:number) {
    const peer=toInputPeer(this.channel(user,target));
    const result=id === undefined
      ? await this.deps.tg.invoke(target.accountId,new Api.messages.GetScheduledHistory({peer,hash:bigInt.zero}),{expectedTelegramUserId:actor})
      : await this.deps.tg.invoke(target.accountId,new Api.messages.GetScheduledMessages({peer,id:[id]}),{expectedTelegramUserId:actor});
    this.channel(user,target);
    if (!('messages' in result)) throw new GatewayError('UNAVAILABLE','Telegram did not return the scheduling queue.');
    return result.messages.filter((m):m is Api.Message=>m.className==='Message' && peerKeyOfPeer(m.peerId)===target.chatKey &&
      (id===undefined || m.id===id) && !m.fromScheduled);
  }

  async list(user:string,target:Omit<PostTarget,'postId'>) {
    this.channel(user,target);
    const actor=(await this.deps.tg.whoami(target.accountId)).tgUserId;
    const posts=await this.queue(user,target,actor);
    return {total:posts.length,items:posts.slice(0,20).map(p=>({id:p.id,schedule_date:p.date,preview:p.message.slice(0,100)}))};
  }

  private async state(user:string,target:PostTarget,scheduled:boolean,actor?:string) {
    if (!scheduled) return this.deps.write.readPostEditState(user,target,actor);
    this.channel(user,target);
    const identity=actor ?? (await this.deps.tg.whoami(target.accountId)).tgUserId;
    const queue=await this.queue(user,target,identity,target.postId);
    if (queue.length !== 1) throw new GatewayError('MESSAGE_NOT_FOUND','The scheduled item is missing from this account and channel queue.');
    return postEditState(target,queue[0],identity);
  }

  private async self(state:PostEditState) {
    return this.deps.write.postEditAccount(state.target.accountId,state.telegramUserId);
  }

  private async rights(user:string,state:PostEditState,writes:boolean,op:SpecialOp) {
    const {post}=state;
    const denial=await this.deps.write.postEditCapability(user,state,writes,'special');
    if (denial) throw new GatewayError(denial.code,denial.reason);
    ordinary(post,op==='edit_keyboard');
    if (op==='edit_keyboard') {
      this.ordinaryMedia(state);
      const me=await this.self(state);
      if (!me.bot || !post.out || post.fromId?.className !== 'PeerUser' || String(post.fromId.userId)!==state.telegramUserId) {
        throw new GatewayError('WRITE_FORBIDDEN','Only the bot that authored the post can set or clear this keyboard.');
      }
      if (keyboardRows(post.replyMarkup) === undefined) invalid('Only plain URL keyboards can be changed. This keyboard has other button types or styles.');
    } else if (op==='close_poll') {
      const poll=pollOn(post);
      if (!poll.creator && !post.out) throw new GatewayError('WRITE_FORBIDDEN','Close a poll or quiz that this account created.');
    } else this.ordinaryMedia(state);
    this.deps.write.requirePostWriteAccess(user,state.target);
  }

  private ordinaryMedia(state:PostEditState) {
    const post=state.post;
    const refusal=specialRefusal({...post,replyMarkup:undefined} as PublishedPost);
    if (refusal) invalid(refusal);
    if (state.card.kind==='unavailable' && !state.fields.attachment) invalid('This media cannot be safely verified after a special post edit.');
  }

  async inspect(user:string,target:PostTarget,writes:boolean,scheduled:boolean) {
    const state=await this.state(user,target,scheduled);
    const {post}=state;
    const op:SpecialOp=scheduled?'edit_scheduled':post.media?.className==='MessageMediaPoll'?'close_poll':'edit_keyboard';
    let denied;
    try {
      await this.rights(user,state,writes,op);
      if (scheduled) this.lead(post.date);
    } catch(err) {
      if (!isGatewayError(err)) throw err;
      denied={code:err.code,reason:err.message};
    }
    const contentDenial=scheduled ? scheduledContentDenial(state) : undefined;
    const media=post.media?.className ?? 'MessageMediaEmpty';
    const poll=post.media?.className==='MessageMediaPoll'?post.media.poll:undefined;
    return {available:!denied,...denied,op,media,
      ...(scheduled?{schedule_date:post.date,schedule_repeat_period:post.scheduleRepeatPeriod??null,
        value:post.message, content_available:!denied&&!contentDenial,
        ...(contentDenial?{content_reason:contentDenial}:{entities:(post.entities??[]).map(describeEntity)})}:{}),
      ...(post.replyMarkup?{keyboard:keyboardRows(post.replyMarkup)??{kind:post.replyMarkup.className}}:{}),
      ...(poll?{poll:{id:String(poll.id),question:poll.question.text,closed:!!poll.closed,quiz:!!poll.quiz}}:{})};
  }

  async prepare(user:string,target:PostTarget,writes:boolean,request:Request) {
    const {op,options,replacement,entities_json}=request;
    const scheduled=op==='edit_scheduled';
    const state=await this.state(user,target,scheduled);
    await this.rights(user,state,writes,op);
    const common={...target,version:1 as const,actor:state.telegramUserId,revision:revision(state),expected:snapshot(state)};
    const {post}=state;
    let checked: { plan:SpecialPlan; before:unknown; after:unknown };
    if (op==='close_poll') {
      if (Object.keys(options).length || replacement!==undefined || entities_json!==undefined) invalid('close_poll only takes a published post target.');
      const poll=pollOn(post);
      const definition={id:String(poll.id),question:poll.question.text,quiz:!!poll.quiz};
      checked={plan:{...common,op,expected:{...common.expected,poll_closed:true}},
        before:{...definition,closed:!!poll.closed},after:{...definition,closed:true}};
    } else if (op==='edit_keyboard') {
      if (!options.rows || options.schedule_date!==undefined || options.schedule_repeat_period!==undefined ||
          replacement!==undefined || entities_json!==undefined) invalid('Use rows alone to set a URL keyboard. Use [] to clear it.');
      const expected=specialFields(new Api.Message({...post,replyMarkup:markupFor(options.rows)}),state.fields);
      checked={plan:{...common,op,rows:options.rows,expected},before:keyboardRows(post.replyMarkup),after:options.rows};
    } else {
      if (options.rows!==undefined || (replacement===undefined)!==(entities_json===undefined) ||
          (replacement===undefined && options.schedule_date===undefined && options.schedule_repeat_period===undefined)) {
        invalid('Pass a schedule date, repeat interval or replacement with explicit entities_json.');
      }
      const original={date:post.date,repeat:post.scheduleRepeatPeriod??null};
      const schedule={date:options.schedule_date??original.date,repeat:options.schedule_repeat_period??original.repeat};
      this.lead(original.date);
      this.lead(schedule.date);
      if (schedule.repeat!==null && !(await this.self(state)).premium) invalid('Telegram Premium is required for a repeating schedule.');
      let patch:Patch|undefined;
      let expected={...common.expected,repeat:schedule.repeat,
        author:semanticFields(new Api.Message({...post,date:schedule.date})).author};
      if (replacement!==undefined) {
        const denial=scheduledContentDenial(state);
        if (denial) invalid(denial);
        const limits=await this.deps.write.contentLimits(target.accountId,state.telegramUserId,isCaption(post));
        const content=prepareContent(state, replacement==='' && entities_json?.trim()==='[]' && isCaption(post)
          ? {op:'clear_caption'} : {op:'replace_content',replacement,entities_json},limits.length);
        if (content.status!=='preview') invalid('The replacement could not be prepared.');
        patch={value:content.plan.value,spans:content.plan.spans};
        if (patch.spans.some(e=>e.type==='mention_name')) invalid('Scheduled edits cannot add account-bound mentions.');
        await this.deps.write.checkOutgoingEntities(content.plan,patch.value,patch.spans,limits);
        expected={...expected,text:content.plan.expected.text,entities:content.plan.expected.entities};
      }
      checked={plan:{...common,op,schedule,patch,expected},
        before:{schedule_date:original.date,schedule_repeat_period:original.repeat,...(patch?{value:post.message,entities:(post.entities??[]).map(describeEntity)}:{})},
        after:{schedule_date:schedule.date,schedule_repeat_period:schedule.repeat,...(patch?{value:patch.value,entities:patch.spans}:{})}};
    }
    this.deps.write.requirePostWriteAccess(user,target);
    return checked;
  }

  async execute(user:string,plan:SpecialPlan,approvalId:string) {
    if (plan.version!==1 || !plan.actor) stale('Prepare a fresh special post preview.');
    const scheduled=plan.op==='edit_scheduled';
    return this.deps.write.withPostLocks(scheduled?plan.chatKey+'/scheduled':plan.chatKey,[plan.postId],async()=>{
      let state=await this.state(user,plan,scheduled,plan.actor);
      await this.rights(user,state,true,plan.op);
      if (plan.op==='edit_scheduled') {
        if (plan.schedule.repeat!==null && !(await this.self(state)).premium) stale('This account no longer supports the approved repeat interval.');
        if (plan.patch) {
          const limits=await this.deps.write.contentLimits(plan.accountId,plan.actor,isCaption(state.post));
          if ([...plan.patch.value].length>limits.length) invalid('The replacement exceeds the current account limit.');
          await this.deps.write.checkOutgoingEntities({ ...plan,telegramUserId:plan.actor },plan.patch.value,plan.patch.spans,limits);
        }
      }
      let telegramTime: { server:number; elapsed:number } | undefined;
      if (scheduled) {
        const start=performance.now();
        const clock=await this.deps.tg.invoke(plan.accountId,new Api.updates.GetState(),{expectedTelegramUserId:plan.actor});
        if (!Number.isSafeInteger(clock.date) || clock.date<=0) throw new GatewayError('UNAVAILABLE','Cannot verify Telegram time for the queue edit.');
        telegramTime={server:clock.date,elapsed:start};
      }
      state=await this.state(user,plan,scheduled,plan.actor);
      if (plan.revision!==revision(state)) stale('The post or queue entry changed after preview.');
      const access=()=>{
        if (plan.op==='edit_scheduled' && telegramTime) {
          const now=Math.max(Math.floor(this.deps.now()/1000),telegramTime.server+Math.ceil((performance.now()-telegramTime.elapsed)/1000));
          this.lead(state.post.date,now);
          this.lead(plan.schedule.date,now);
        }
        return this.deps.write.requirePostWriteAccess(user,plan);
      };
      const peer=toInputPeer(access());
      const original=state.post;
      const change=plan.op==='edit_scheduled'
        ? {scheduleDate:plan.schedule.date,scheduleRepeatPeriod:plan.schedule.repeat??undefined,
          ...(plan.patch ? {message:plan.patch.value,entities:this.deps.write.contentEntities(user,{...plan,spans:plan.patch.spans},state),
            noWebpage:isCaption(original)?undefined:true,invertMedia:original.invertMedia||undefined}:{})}
        : plan.op==='edit_keyboard' ? {replyMarkup:markupFor(plan.rows)} : {media:closeMedia(pollOn(original))};
      const actual=snapshot(state,plan.op==='edit_scheduled' && !!plan.patch);
      let evidence:Evidence='already_matched';
      if (differences(plan.expected,actual,true).length || plan.expected.markup_bytes!==actual.markup_bytes ||
          plan.expected.poll_closed!==actual.poll_closed) {
        this.deps.store.updateApproval(approvalId,{result:{rpc_evidence:'unknown'}});
        try {
          await this.deps.tg.invoke(plan.accountId,new Api.messages.EditMessage({peer,id:plan.postId,...change}),
            {expectedTelegramUserId:plan.actor,beforeInvoke:access,write:true,singleAttempt:true});
          evidence='acknowledged';
        } catch(err) {
          if (isGatewayError(err) && err.telegramCode==='MESSAGE_NOT_MODIFIED') evidence='not_modified';
          else if (isGatewayError(err) && err.outcomeUnknown) evidence='unknown';
          else { this.deps.store.updateApproval(approvalId,{result:null});throw err; }
        }
      }
      this.deps.store.updateApproval(approvalId,{result:{rpc_evidence:evidence}});
      const observed=await this.observe(user,plan,evidence);
      if(observed.data.outcome==='verified')this.deps.write.recordPostEdit(user,plan);
      return observed;
    });
  }

  async observe(user:string,plan:SpecialPlan,recorded:unknown) {
    const evidence=recorded==='already_matched'||recorded==='not_modified'||recorded==='acknowledged'?recorded:'unknown';
    const scheduled=plan.op==='edit_scheduled';
    const data={op:plan.op,chat:plan.chatKey,message_id:plan.postId,namespace:scheduled?'scheduled':'published',rpc_evidence:evidence};
    try {
      if (plan.version!==1 || !plan.actor) stale('The approved format is unavailable.');
      const state=await this.state(user,plan,scheduled,plan.actor);
      const actual=snapshot(state,plan.op==='edit_scheduled' && !!plan.patch);
      const diff=differences(plan.expected,actual,true);
      if (plan.op==='edit_scheduled' && state.post.date!==plan.schedule.date) diff.push('schedule_date');
      const outcome=diff.length ? evidence==='unknown'?'outcome_unknown':'conflict' :
        evidence==='not_modified'||evidence==='already_matched'?'no-op':'verified';
      return {summary:'Observed '+data.namespace+' post: '+outcome,data:{...data,outcome,differences:diff}};
    } catch(err) {
      return {summary:'Unable to verify the approved '+data.namespace+' post.',data:{...data,outcome:'outcome_unknown',
        read_error:isGatewayError(err)?err.code:'UNAVAILABLE',...(isGatewayError(err)&&err.retryAfter?{retry_after:err.retryAfter}:{})}};
    }
  }
}
