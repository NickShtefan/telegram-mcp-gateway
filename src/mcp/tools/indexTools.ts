/**
 * `index` toolset: local message index. `tg_index` stores chat messages
 * in the gateway database; `tg_local_search` searches without Telegram calls.
 */
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { createEnvelope, safeLabel } from '../../policy/envelope.js';
import { messageLink } from '../../services/links.js';
import { INDEX_DEFAULT_DAYS, INDEX_MAX_DAYS, INDEX_MAX_PER_RUN, type IndexedChat, type IndexJobParams, type IndexJobResult } from '../../services/localIndex.js';
import type { MessageDto } from '../../services/messages.js';
import type { EntityRecord, JobRecord } from '../../storage/port.js';
import { clampLimit, describeWindow, parseWindow } from '../args.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { compactNumber, formatDate, formatMessageList } from '../format.js';
import { defineTool, type ToolContext, type ToolDef } from '../tool.js';
import { accountArg, chatLabel, cursorArg, sinceArg, untilArg } from './shared.js';

/** Time to wait for indexing before returning job_id. */
const INDEX_WAIT_MS = 20_000;
const DAY = 86_400;

function chatOf(ctx: ToolContext, accountId: string, chatKey: string): EntityRecord | null {
  return ctx.services.runtime.storage.entities.get(accountId, chatKey);
}

function renderIndexJob(ctx: ToolContext, job: JobRecord): string {
  const params = job.params as unknown as IndexJobParams;
  const chat = chatOf(ctx, params.accountId, params.chatKey);
  const label = chat ? chatLabel(chat) : `id ${params.chatKey}`;
  if (job.state === 'failed') return `Indexing of ${label} failed.\njob_id: ${job.id}\nerror: ${job.error ?? 'unknown'}`;
  if (job.state !== 'done') {
    const progress = job.progress as { scanned?: number; added?: number };
    return [
      `Indexing of ${label} is ${job.state === 'queued' ? 'queued' : 'running'}: scanned ${progress.scanned ?? 0} messages so far.`,
      `job_id: ${job.id}`,
      'Call tg_index again with only this job_id to check. Messages already stored are searchable now.',
    ].join('\n');
  }
  const result = job.result as IndexJobResult;
  const lines = [
    `Indexed ${label}: ${compactNumber(result.messages)} messages in the local index (${result.added} new, ${result.scanned} read from Telegram).`,
    `The index covers this chat since ${formatDate(result.sinceTs)} UTC. Search it with tg_local_search; run tg_index again later to add new messages.`,
  ];
  if (result.partial) {
    lines.push(`This run stopped at its limit of ${INDEX_MAX_PER_RUN} messages: call tg_index again with the same arguments to go further back.`);
  }
  return lines.join('\n');
}

function indexedLine(ctx: ToolContext, item: IndexedChat): string {
  const chat = chatOf(ctx, item.accountId, item.chatKey);
  return [
    chat ? chatLabel(chat) : `id ${item.chatKey}`,
    `account ${item.accountId}`,
    `${compactNumber(item.messages)} messages`,
    `since ${formatDate(item.sinceTs).slice(0, 10)}`,
    item.syncedAt !== null ? `synced ${formatDate(Math.floor(item.syncedAt / 1000))}` : 'never synced',
  ].join(' | ');
}

/** Chat indexes currently accessible to this user. */
function visibleIndexes(ctx: ToolContext, accountIds: string[]): Array<{ item: IndexedChat; chat: EntityRecord }> {
  const out: Array<{ item: IndexedChat; chat: EntityRecord }> = [];
  for (const item of ctx.services.indexStore.list(accountIds)) {
    const chat = chatOf(ctx, item.accountId, item.chatKey);
    // Access may have been revoked since indexing; hide the index from listing and search.
    if (chat && ctx.services.scopes.isAllowed(ctx.principal.userId, item.accountId, chat)) out.push({ item, chat });
  }
  return out;
}

const tgIndex = defineTool({
  name: 'tg_index',
  toolset: 'index',
  title: 'Index a chat for local search',
  description:
    'Stores the messages of a chat in the gateway so that tg_local_search can search them instantly, without Telegram rate limits. action=add (default) indexes the chat or adds what is new since the last run; list shows indexed chats; remove deletes an index. A long first run returns job_id: call again with only job_id.',
  input: {
    action: z.enum(['add', 'list', 'remove']).optional().describe('add (default), list or remove.'),
    chat: z.string().optional().describe('Chat for add and remove: @username, t.me link or id.'),
    since: z.string().optional().describe(`How far back to index: 90d (default), 1y, 2026-01-01. Max ${Math.round(INDEX_MAX_DAYS / 365)} years.`),
    job_id: z.string().optional().describe('Check a running indexing job instead of starting one.'),
    account: accountArg,
  },
  readOnly: true,
  handler: async (args, ctx) => {
    const { services, principal } = ctx;
    if (args.job_id) {
      const job = await services.jobs.waitFor(args.job_id, principal.userId, 5_000);
      return { accountId: job.accountId, text: renderIndexJob(ctx, job) };
    }
    const action = args.action ?? 'add';

    if (action === 'list') {
      const accounts = args.account ? [ctx.account(args.account)] : principal.accounts;
      const items = visibleIndexes(ctx, accounts);
      const lines = [`Indexed chats: ${items.length}`];
      for (const { item } of items) lines.push(indexedLine(ctx, item));
      if (items.length === 0) lines.push('Nothing is indexed yet. Index a chat with tg_index chat=<chat>.');
      return { text: lines.join('\n'), count: items.length };
    }

    if (!args.chat) throw new GatewayError('INVALID_ARGUMENT', `"chat" is required for action=${action}.`);
    const accountId = ctx.account(args.account);
    const { chat } = await ctx.openChat(args.chat, accountId);

    if (action === 'remove') {
      const existing = services.indexStore.get(accountId, chat.peerKey);
      if (!existing) return { accountId, peerKey: chat.peerKey, text: `${chatLabel(chat)} is not indexed.` };
      if (existing.createdBy !== principal.userId) {
        throw new GatewayError('ACCESS_DENIED', `The index of ${chatLabel(chat)} was created by ${existing.createdBy}: only they can remove it.`);
      }
      const removed = services.indexStore.remove(accountId, chat.peerKey);
      return { accountId, peerKey: chat.peerKey, text: `The index of ${chatLabel(chat)} is removed: ${removed} messages deleted from the gateway.` };
    }

    const nowSec = Math.floor(ctx.now() / 1000);
    const wanted = args.since ? parseWindow(args.since, undefined, ctx.now()).minDate! : nowSec - INDEX_DEFAULT_DAYS * DAY;
    const sinceTs = Math.max(wanted, nowSec - INDEX_MAX_DAYS * DAY);

    // Only one indexing job per chat; a second would interfere.
    const active = [...services.runtime.storage.jobs.list({ state: 'running', limit: 100 }), ...services.runtime.storage.jobs.list({ state: 'queued', limit: 100 })].find(j => {
      const p = j.params as Partial<IndexJobParams>;
      return j.kind === 'index' && p.accountId === accountId && p.chatKey === chat.peerKey;
    });
    if (active) {
      if (active.userId !== principal.userId) {
        return { accountId, peerKey: chat.peerKey, text: `${chatLabel(chat)} is being indexed right now by ${active.userId}. Try tg_local_search in a minute.` };
      }
      const job = await services.jobs.waitFor(active.id, principal.userId, 5_000);
      return { accountId, peerKey: chat.peerKey, text: renderIndexJob(ctx, job) };
    }

    const params: IndexJobParams = { accountId, chatKey: chat.peerKey, sinceTs };
    const started = services.jobs.start({ userId: principal.userId, accountId, kind: 'index', params: params as unknown as Record<string, unknown> });
    const job = await services.jobs.waitFor(started.id, principal.userId, INDEX_WAIT_MS);
    const count = job.state === 'done' ? (job.result as IndexJobResult).messages : null;
    return { accountId, peerKey: chat.peerKey, count, text: renderIndexJob(ctx, job) };
  },
});

const tgLocalSearch = defineTool({
  name: 'tg_local_search',
  toolset: 'index',
  title: 'Search the local index',
  description:
    'Full-text search over chats indexed with tg_index: instant, no Telegram requests, no rate limits. Matches word parts regardless of case and word ending ("bicycle" finds "bicycles"); every word of the query must be present. Results are as fresh as the last tg_index run for each chat.',
  input: {
    query: z.string().min(1).describe('Words to find; at least one of 3 or more characters.'),
    chat: z.string().optional().describe('Search only this indexed chat. Default: all indexed chats.'),
    since: sinceArg,
    until: untilArg,
    mode: z.enum(['brief', 'full']).optional().describe('brief (default) or full texts.'),
    limit: z.number().int().optional().describe('Results per page: default 20, max 50.'),
    cursor: cursorArg,
    account: accountArg,
  },
  readOnly: true,
  handler: async (args, ctx) => {
    const { services, principal } = ctx;
    const limit = clampLimit(args.limit, 20, 50);
    const window = parseWindow(args.since, args.until, ctx.now());
    const query = args.query.trim();

    let targets = visibleIndexes(ctx, args.account ? [ctx.account(args.account)] : principal.accounts);
    if (args.chat) {
      const accountId = ctx.account(args.account);
      const { chat } = await ctx.openChat(args.chat, accountId);
      targets = targets.filter(t => t.item.accountId === accountId && t.item.chatKey === chat.peerKey);
      if (targets.length === 0) {
        throw new GatewayError('NOT_FOUND', `${chatLabel(chat)} is not indexed. Index it first: tg_index chat=${chat.username ? `@${chat.username}` : chat.peerKey}.`);
      }
    }
    if (targets.length === 0) {
      return { text: 'Nothing is indexed yet, so there is nothing to search. Index a chat with tg_index, or search Telegram directly with tg_search_chat.', count: 0 };
    }

    let offset = 0;
    if (args.cursor) {
      const cursor = decodeCursor<{ o: number; q: string }>('lsearch', args.cursor);
      if (cursor.q !== query) throw new GatewayError('INVALID_ARGUMENT', 'This cursor belongs to another query. Omit it to start over.');
      offset = cursor.o;
    }

    const found = services.localIndex.search(
      targets.map(t => ({ accountId: t.item.accountId, chat: t.chat })),
      { query, minDate: window.minDate, maxDate: window.maxDate, limit, offset },
    );
    const chats = new Map(targets.map(t => [`${t.item.accountId}:${t.item.chatKey}`, t.chat]));
    const accountOf = new Map(found.messages.map(f => [f.message, f.accountId]));
    const chatFor = (m: MessageDto): EntityRecord | null => chats.get(`${accountOf.get(m) ?? ''}:${m.chatKey}`) ?? null;

    const stalest = targets.reduce<number | null>((min, t) => (t.item.syncedAt === null ? min : min === null ? t.item.syncedAt : Math.min(min, t.item.syncedAt)), null);
    const more = offset + found.messages.length < found.total && found.messages.length > 0;
    const hints = [stalest !== null ? `Index last synced: ${formatDate(Math.floor(stalest / 1000))} UTC. Newer messages need tg_index.` : ''];

    return {
      count: found.messages.length,
      text: formatMessageList(
        found.messages.map(f => f.message),
        {
          title: `Local search "${safeLabel(query, 60)}": ${found.messages.length} of ${found.total} matches in ${targets.length} indexed chat(s)${describeWindow(window)}`,
          mode: args.mode ?? 'brief',
          maxTextChars: 700,
          envelope: createEnvelope(),
          linkFor: m => {
            const chat = chatFor(m);
            return chat ? messageLink({ username: chat.username, peerKey: chat.peerKey, messageId: m.id, topicId: m.topicId ?? undefined }) : null;
          },
          chatLabel: targets.length > 1 ? m => (chatFor(m) ? chatLabel(chatFor(m)!) : null) : undefined,
          nextCursor: more ? encodeCursor('lsearch', { o: offset + limit, q: query }) : null,
          hints: hints.filter(Boolean),
        },
      ),
    };
  },
});

export const INDEX_TOOLS: ToolDef[] = [tgIndex, tgLocalSearch] as unknown as ToolDef[];
