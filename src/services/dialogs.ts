/**
 * Account dialogs: channels, groups, and private conversations. Tools
 * decide which results to expose according to scopes.
 *
 * messages.GetDialogs returns pages newest first. Next-page positions
 * use the final dialog's latest message date and ID and
 * the dialog peer. Read archive folder 1 in a separate pass
 * so archived chats are not omitted.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { entityFromApi, peerKeyOfPeer, toInputPeer, type EntityInfo } from '../core/entities.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo } from '../storage/port.js';
import { chatTypeOf, type ChatType } from './resolve.js';

const DIALOGS_PAGE_MAX = 100;

/** Dialog folder: 0 for the main list, 1 for archive. */
export type DialogFolder = 0 | 1;

export interface DialogsPosition {
  offsetDate: number;
  offsetId: number;
  offsetPeerKey: string;
}

export interface DialogDto {
  chat: EntityInfo;
  type: ChatType;
  members: number | null;
  unread: number;
  /** Latest message time in Unix seconds, or null when absent. */
  lastDate: number | null;
  pinned: boolean;
  archived: boolean;
  /** Position immediately after this dialog, suitable for resuming the list. */
  position: DialogsPosition | null;
}

export interface DialogsPage {
  dialogs: DialogDto[];
  /** Next-page position, or null when the folder is exhausted. */
  next: DialogsPosition | null;
}

interface RawDialog {
  className?: string;
  peer?: unknown;
  topMessage?: number;
  unreadCount?: number;
  pinned?: boolean;
}

interface RawMessage {
  id?: number;
  date?: number;
  peerId?: unknown;
}

interface RawDialogs {
  className?: string;
  dialogs?: RawDialog[];
  messages?: RawMessage[];
  chats?: unknown[];
  users?: unknown[];
}

export class DialogsService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
  ) {}

  async page(
    accountId: string,
    params: { folder: DialogFolder; limit: number; position?: DialogsPosition | null },
    options?: TgCallOptions,
  ): Promise<DialogsPage> {
    const limit = Math.min(Math.max(1, params.limit), DIALOGS_PAGE_MAX);
    const position = params.position ?? null;
    const offsetEntity = position ? this.entities.get(accountId, position.offsetPeerKey) : null;

    const result = (await this.tg.invoke(
      accountId,
      new Api.messages.GetDialogs({
        folderId: params.folder,
        offsetDate: position?.offsetDate ?? 0,
        offsetId: position?.offsetId ?? 0,
        offsetPeer: offsetEntity ? toInputPeer(offsetEntity) : new Api.InputPeerEmpty(),
        limit,
        hash: bigInt.zero,
      }),
      options,
    )) as unknown as RawDialogs;

    const infos = new Map<string, EntityInfo>();
    for (const item of [...(result.chats ?? []), ...(result.users ?? [])]) {
      const info = entityFromApi(item);
      if (info) infos.set(info.peerKey, info);
    }
    const dates = new Map<string, number>();
    for (const m of result.messages ?? []) {
      const key = peerKeyOfPeer(m.peerId);
      if (key !== null && typeof m.id === 'number' && typeof m.date === 'number') dates.set(`${key}:${m.id}`, m.date);
    }

    const raw = (result.dialogs ?? []).filter(d => d.className === 'Dialog');
    const dialogs: DialogDto[] = [];
    let lastPosition: DialogsPosition | null = null;
    let lastPinned = false;
    for (const d of raw) {
      const key = peerKeyOfPeer(d.peer);
      const chat = key !== null ? infos.get(key) : undefined;
      if (key === null || !chat) continue;
      const lastDate = typeof d.topMessage === 'number' ? (dates.get(`${key}:${d.topMessage}`) ?? null) : null;
      const pos: DialogsPosition | null = lastDate !== null && typeof d.topMessage === 'number' ? { offsetDate: lastDate, offsetId: d.topMessage, offsetPeerKey: key } : null;
      // Pinned dialogs ignore date order; use them for positions only when no ordinary dialogs exist.
      if (pos && (d.pinned !== true || lastPosition === null || lastPinned)) {
        lastPosition = pos;
        lastPinned = d.pinned === true;
      }
      const members = typeof chat.meta.participants === 'number' ? chat.meta.participants : null;
      dialogs.push({
        chat,
        type: chatTypeOf(chat),
        members,
        unread: d.unreadCount ?? 0,
        lastDate,
        pinned: d.pinned === true,
        archived: params.folder === 1,
        position: pos,
      });
    }

    // messages.Dialogs means fewer than a page of results, with no more to read.
    const complete = result.className === 'messages.Dialogs' || raw.length < limit || lastPosition === null;
    return { dialogs, next: complete ? null : lastPosition };
  }
}
