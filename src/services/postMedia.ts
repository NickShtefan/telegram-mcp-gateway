import { Api } from 'teleproto';
import { peerKeyOfPeer, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import type { WriteStore } from '../writegate/store.js';
import type { HistoryService } from './history.js';
import { differences, postEditState, type PostEditState, type PostTarget, type PublishedPost } from './linkEdit.js';
import { assetOf, conflict, eligible, inputMedia, invalid, MEDIA_EDIT, settings, type Asset, type MediaOptions } from './mediaPayload.js';
import { openUpload, uploadAsset, type UploadHandle } from './mediaUpload.js';
import type { WriteService } from './write.js';

type Fields = PostEditState['fields'];
type Source = { target: PostTarget; id: string; attachment: string };
interface Member { id: number; revision: string }
export interface MediaPlan extends PostTarget {
  op: typeof MEDIA_EDIT; version: 1; actor: string; revision: string; items: Member[]; before: Fields;
  source?: Source; upload?: UploadHandle; cover?: Source; options: MediaOptions;
  attributes: ReturnType<typeof settings>;
}
interface Dependencies {
  write: WriteService; history: HistoryService; store: WriteStore; home: string; tg: Tg;
  chat(user: string, target: PostTarget): EntityRecord;
}
interface MediaArgs { source?: PostTarget; upload?: string; cover?: PostTarget; options: MediaOptions }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

/** Immutable source identity and semantic results only. Never store Telegram file references. */
function binding(state: PostEditState, asset: Asset): Source {
  if (!state.fields.attachment) invalid('The attachment cannot be fingerprinted.');
  return { target:state.target, id:asset.info.id, attachment:state.fields.attachment };
}
function wantedMedia(asset: Asset, attrs: MediaPlan['attributes'], cover?: Api.Photo) {
  const spoiler = attrs.spoiler || undefined;
  return asset.object.className === 'Photo' ? new Api.MessageMediaPhoto({ photo:asset.object, spoiler })
    : new Api.MessageMediaDocument({ document:asset.object, video:asset.videoFlag || undefined, spoiler,
      videoCover: attrs.cover ? cover : undefined, videoTimestamp:attrs.timestamp ?? undefined });
}
type Evidence = 'unknown' | 'acknowledged' | 'not_modified' | 'already_matched';

export class PostMediaService {
  constructor(private readonly deps: Dependencies) {}

  private async members(user: string, state: PostEditState, observing = false) {
    const { target, telegramUserId: actor } = state;
    if (!state.post.groupedId) return [state];
    const chat = this.deps.chat(user,target);
    const group = await this.deps.history.album(target.accountId,chat,target.postId,{expectedTelegramUserId:actor});
    this.deps.chat(user,target);
    const items = group.raw.map(entry => {
      const post = entry as PublishedPost;
      if (post.className !== 'Message' || !post.post || peerKeyOfPeer(post.peerId) !== target.chatKey ||
          String(post.groupedId) !== String(state.post.groupedId)) conflict('The album changed during inspection.');
      return postEditState({...target,postId:post.id},post,actor);
    });
    if ((!observing && items.length < 2) || items.length > 10 || new Set(items.map(i => i.target.postId)).size !== items.length ||
        !items.some(i => i.target.postId === target.postId && i.revision === state.revision)) conflict('The complete album is unavailable or changed.');
    return items;
  }

  private sourceAccess(user: string, source: PostTarget, target: PostTarget) {
    const chat = this.deps.chat(user,source);
    if (source.accountId !== target.accountId) invalid('Media handles belong to a single account.');
    if ((source.chatKey !== target.chatKey || source.postId !== target.postId) && chat.meta.noforwards !== false) {
      invalid('The source channel disallows copying or its copying policy is unknown.');
    }
  }

  private async source(user: string, target: PostTarget, actor: string, destination: PostTarget) {
    const state = await this.deps.write.readPostEditState(user,target,actor);
    this.sourceAccess(user,target,destination);
    if ((target.chatKey !== destination.chatKey || target.postId !== destination.postId) &&
        state.post.noforwards) invalid('This source is protected or its channel copying policy is unknown.');
    const asset = assetOf(state.post.media);
    return { asset, ref: binding(state,asset) };
  }

  async prepare(user: string, target: PostTarget, writes: boolean, args?: MediaArgs) {
    const state = await this.deps.write.readPostEditState(user,target);
    const identity = { op:MEDIA_EDIT, account:target.accountId, chat:target.chatKey, message_id:target.postId };
    let current: Asset;
    let group: PostEditState[];
    try {
      current = eligible(state.post);
      group = await this.members(user,state);
      for (const item of group) eligible(item.post);
    } catch (err) {
      if (args || !isGatewayError(err)) throw err;
      return { ...identity, view:'media', available:false, code:err.code, reason:err.message };
    }
    const denial = await this.deps.write.postEditCapability(user,state,writes,'media');
    const ids = group.map(i => i.target.postId);
    if (!args) return { ...identity, view:'media', available:!denial, ...denial, media:current.info, items:ids };
    if (denial) throw new GatewayError(denial.code,denial.reason);
    const {options} = args;
    if (!args.source && !args.upload && !Object.keys(options).length) invalid('Supply a media_source or explicit media options.');
    if (!args.upload && [options.upload_as,options.filename,options.width,options.height,options.duration].some(v=>v!==undefined)) invalid('A filename or file attribute change requires a new upload.');
    const source = args.source ? await this.source(user,args.source,state.telegramUserId,target) : undefined;
    const upload = args.upload !== undefined ? (await openUpload(this.deps.home,user,target.accountId,args.upload,options)).handle : undefined;
    const next = source?.asset.info ?? upload ?? current.info;
    if (group.length > 1 && group.some(i => (eligible(i.post).info.kind === 'document') !== (next.kind === 'document'))) {
      invalid('A document album takes documents. A visual album takes photos and videos.');
    }
    const cover = args.cover ? await this.source(user,args.cover,state.telegramUserId,target) : undefined;
    if (cover && cover.asset.object.className !== 'Photo') invalid('The cover must reference a photo post.');
    const photo = cover?.asset.object.className === 'Photo' ? cover.asset.object : undefined;
    const attributes = settings(current.info,next.kind,options,photo,next.duration);
    for (const bound of [source,cover]) if (bound) this.sourceAccess(user,bound.ref.target,target);
    this.deps.write.requirePostWriteAccess(user,target);
    const plan: MediaPlan = { ...target, op:MEDIA_EDIT, version:1, actor:state.telegramUserId, revision:state.revision,
      items:group.map(i=>({ id:i.target.postId,revision:i.revision })), before:state.fields, options, attributes,
      ...(source ? {source:source.ref} : {}), ...(upload ? {upload} : {}), ...(cover ? {cover:cover.ref} : {}) };
    return { ...identity, status:'preview', telegram_user_id:plan.actor, items:ids, before:current.info,
      after:{ ...next, ...attributes }, ...(source ? {source:{chat:source.ref.target.chatKey,message_id:source.ref.target.postId}} : {}),
      ...(cover ? {cover_source:{chat:cover.ref.target.chatKey,message_id:cover.ref.target.postId}} : {}), plan };
  }

  private async checkTarget(user: string, plan: MediaPlan) {
    const state = await this.deps.write.readPostEditState(user,plan,plan.actor);
    const group = await this.members(user,state);
    if (state.revision !== plan.revision || !same(plan.items,group.map(i=>({id:i.target.postId,revision:i.revision})))) conflict('The post or another album item changed since preview.');
    const denial = await this.deps.write.postEditCapability(user,state,true,'media');
    if (denial) throw new GatewayError(denial.code,denial.reason);
    return state;
  }

  private async refresh(user: string, plan: MediaPlan, bound: Source) {
    const result = await this.source(user,bound.target,plan.actor,plan);
    if (result.ref.id !== bound.id || result.ref.attachment !== bound.attachment) conflict('The source attachment changed. Prepare a new preview.');
    return result.asset;
  }

  async execute(user: string, plan: MediaPlan, approvalId: string) {
    if (plan.version !== 1 || plan.op !== MEDIA_EDIT || !plan.actor) conflict('Prepare a fresh media approval.');
    return this.deps.write.withPostLocks(plan.chatKey,plan.items.map(i=>i.id),async()=>{
      const access = () => {
        for (const bound of [plan.source,plan.cover]) if (bound) this.sourceAccess(user,bound.target,plan);
        return this.deps.write.requirePostWriteAccess(user,plan);
      };
      const opts = { expectedTelegramUserId:plan.actor, beforeInvoke:access, write:true, singleAttempt:true };
      let state = await this.checkTarget(user,plan);
      let uploadedId: string | undefined;
      for (let attempt=0;;attempt++) {
        let upload: Asset | undefined;
        if (plan.upload) {
          const file = await openUpload(this.deps.home,user,plan.accountId,plan.upload.name,plan.options);
          if (!same(file.handle,plan.upload)) conflict('The staged upload changed after approval.');
          upload = await uploadAsset(this.deps.tg,plan.accountId,toInputPeer(access()),plan.upload,file.bytes,opts);
          if (uploadedId && upload.info.id !== uploadedId) conflict('The refreshed upload has a different Telegram identity.');
          uploadedId = upload.info.id;
        }
        const replacement = upload ?? (plan.source ? await this.refresh(user,plan,plan.source) : undefined);
        const coverAsset = plan.cover ? await this.refresh(user,plan,plan.cover) : undefined;
        state = await this.checkTarget(user,plan);
        const asset = replacement ?? eligible(state.post);
        const cover = coverAsset?.object.className === 'Photo' ? coverAsset.object : eligible(state.post).cover;
        const media = inputMedia(asset,plan.attributes,cover);
        const expected = postEditState(plan,new Api.Message({...state.post,media:wantedMedia(asset,plan.attributes,cover)}),plan.actor).fields;
        // Persist the server-assigned upload identity before issuing an edit. Recovery only observes.
        this.deps.store.updateApproval(approvalId,{payload:{...plan,expected},result:null});
        let evidence: Evidence = 'already_matched';
        if (differences(expected,state.fields).length) {
          try {
            await this.deps.tg.invoke(plan.accountId,new Api.messages.EditMessage({ peer:toInputPeer(access()), id:plan.postId, media,
              invertMedia:state.post.invertMedia || undefined }),opts);
            evidence='acknowledged';
          } catch (err) {
            if (attempt === 0 && isGatewayError(err) && !err.outcomeUnknown && /^FILE_REFERENCE_(?:EXPIRED|INVALID)$/.test(err.telegramCode ?? '')) {
              this.deps.store.updateApproval(approvalId,{payload:{...plan},result:null});
              state = await this.checkTarget(user,plan);
              continue;
            }
            if (isGatewayError(err) && err.telegramCode === 'MESSAGE_NOT_MODIFIED') evidence='not_modified';
            else if (isGatewayError(err) && err.outcomeUnknown) evidence='unknown';
            else throw err;
          }
        }
        this.deps.store.updateApproval(approvalId,{result:{rpc_evidence:evidence}});
        const result = await this.observe(user,plan,expected,evidence);
        if (result.data.outcome === 'verified') this.deps.write.recordPostEdit(user,plan);
        return result;
      }
    });
  }

  async observe(user: string, plan: MediaPlan, expected?: Fields, evidence: unknown = 'unknown') {
    const data = { op:MEDIA_EDIT, chat:plan.chatKey, message_id:plan.postId, rpc_evidence:evidence };
    try {
      if (!expected || plan.version !== 1 || !plan.actor) throw new GatewayError('UNAVAILABLE','The expected attachment is unavailable.');
      const chat = this.deps.chat(user,plan);
      const page = await this.deps.history.byIds(plan.accountId,chat,plan.items.map(i=>i.id),{expectedTelegramUserId:plan.actor});
      this.deps.chat(user,plan);
      const observed = new Map<number,PostEditState>();
      for (const raw of page.raw as PublishedPost[]) {
        if (raw.className === 'Message' && raw.post && peerKeyOfPeer(raw.peerId) === plan.chatKey) {
          observed.set(raw.id,postEditState({...plan,postId:raw.id},raw,plan.actor));
        }
      }
      const anchor = [...observed.values()].find(i=>i.fields.album !== null && i.fields.album === plan.before.album) ?? observed.get(plan.postId);
      if (anchor?.post.groupedId) {
        const currentGroup = await this.members(user,anchor,true);
        for (const [id,item] of observed) if (item.fields.album === anchor.fields.album) observed.delete(id);
        for (const item of currentGroup) observed.set(item.target.postId,item);
      }
      const group = [...observed.values()].sort((a,b)=>a.target.postId-b.target.postId);
      const items = group.map(item => {
        const id=item.target.postId;
        const old=plan.items.find(i=>i.id===id);
        const diff=id===plan.postId ? differences(expected,item.fields) : old?.revision===item.revision ? [] : [old?'revision':'added'];
        return {id,differences:diff};
      });
      for (const old of plan.items) if (!items.some(i=>i.id===old.id)) items.push({id:old.id,differences:['missing']});
      const diff=items.flatMap(i=>i.differences.map(field=>i.id===plan.postId?field:'item['+i.id+'].'+field));
      const outcome=diff.length ? (evidence==='unknown'?'outcome_unknown':'conflict') :
        (evidence==='not_modified'||evidence==='already_matched'?'no-op':'verified');
      return { summary:'Media edit read-back: '+outcome, data:{...data,outcome,differences:diff,items} };
    } catch (err) {
      return { summary:'Unable to verify the approved attachment and album.', data:{...data,outcome:'outcome_unknown',
        read_error:isGatewayError(err)?err.code:'UNAVAILABLE', ...(isGatewayError(err)&&err.retryAfter?{retry_after:err.retryAfter}:{})} };
    }
  }
}
