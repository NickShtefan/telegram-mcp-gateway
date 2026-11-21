import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { z } from 'zod';
import { sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import type { PublishedPost, semanticFields } from './linkEdit.js';
import { httpUrl } from './webPreview.js';

export const specialOps = ['edit_scheduled', 'edit_keyboard', 'close_poll'] as const;
export type SpecialOp = typeof specialOps[number];
export const SPECIAL_EDIT = 'edit_special_post';
const periods = [86400, 604800, 1209600, 2592000, 7862400, 15724800, 31536000];
const button = z.object({
  text: z.string().min(1).max(64).refine(s => s.trim() && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(s)),
  url: z.string().max(2048).refine(httpUrl),
}).strict();
const rows = z.array(z.array(button).min(1).max(8)).max(12);
const schema = z.object({
  rows: rows.optional(),
  schedule_date: z.number().int().positive().max(2147483646).optional(),
  schedule_repeat_period: z.number().int().refine(n => periods.includes(n)).optional(),
}).strict();

export type Options = z.infer<typeof schema>;
export type ButtonRows = z.infer<typeof rows>;

export function invalid(message: string): never { throw new GatewayError('INVALID_ARGUMENT',message); }
export function stale(message: string): never { throw new GatewayError('EDIT_CONFLICT',message); }

export function parseOptions(raw?: string): Options {
  try { return schema.parse(JSON.parse(raw ?? '{}')); }
  catch { return invalid('Invalid special_options_json. See the options for scheduled posts and keyboards.'); }
}

export function keyboardRows(markup: Api.TypeReplyMarkup | undefined): ButtonRows | undefined {
  if (!markup) return [];
  if (markup.className !== 'ReplyInlineMarkup') return;
  const result: ButtonRows = [];
  for (const row of markup.rows) {
    const current = [];
    for (const b of row.buttons) {
      if (b.type?.className !== 'InlineButtonTypeUrl' || b.style) return;
      current.push({ text:b.text,url:b.type.url });
    }
    result.push(current);
  }
  return rows.safeParse(result).success ? result : undefined;
}

export function markupFor(rows: ButtonRows) {
  return new Api.ReplyInlineMarkup({rows:rows.map(row => new Api.KeyboardInlineButtonRow({
    buttons:row.map(b => new Api.KeyboardInlineButton({text:b.text,type:new Api.InlineButtonTypeUrl({url:b.url})})),
  }))});
}

export function pollOn(post: PublishedPost) {
  const media = post.media;
  if (media?.className !== 'MessageMediaPoll' || media.poll?.className !== 'Poll') invalid('Choose a published poll or quiz.');
  if (media.attachedMedia || media.results?.solutionMedia || media.poll.answers.some(a => a.className !== 'PollAnswer' || a.media)) {
    invalid('Closing a poll with attachments is outside the supported edit matrix.');
  }
  return media.poll;
}

export function closeMedia(poll: Api.Poll) {
  // Telegram's close-only request uses the original poll ID and an empty definition.
  return new Api.InputMediaPoll({poll:new Api.Poll({ id:poll.id, closed:true,
    question:new Api.TextWithEntities({text:'',entities:[]}),answers:[],hash:bigInt.zero })});
}

export function specialFields(post: PublishedPost, fields: ReturnType<typeof semanticFields>) {
  const media = post.media?.className === 'MessageMediaPoll' ? post.media : undefined;
  const poll = media?.poll;
  const results = media?.results;
  const ordinary = { ...fields, markup:post.replyMarkup?.className ?? null };
  return {
    ...ordinary,
    markup_bytes: post.replyMarkup && !(post.replyMarkup.className === 'ReplyInlineMarkup' && !post.replyMarkup.rows.length)
      ? sha256Hex(post.replyMarkup.getBytes().toString('hex')) : null,
    markup: post.replyMarkup?.className === 'ReplyInlineMarkup' && !post.replyMarkup.rows.length ? null : ordinary.markup,
    poll_definition: poll?.className === 'Poll' ? sha256Hex(new Api.Poll({...poll,hash:bigInt.zero,closed:false,creator:false})
      .getBytes().toString('hex')) : null,
    poll_closed: !!poll?.closed,
    poll_media: !!(media?.attachedMedia || results?.solutionMedia),
    ...(typeof results?.solution === 'string' ? { poll_solution:sha256Hex(JSON.stringify([results.solution,
      results.solutionEntities?.map(e=>e.getBytes().toString('hex'))??[]])) } : {}),
  };
}
export type SpecialFields = ReturnType<typeof specialFields>;

export function specialRefusal(post: PublishedPost) {
  if (post.replyMarkup) return 'This edit cannot preserve the existing keyboard. Keyboard changes require edit_keyboard and its own preview.';
  const type = post.media?.className;
  if (type === 'MessageMediaPaidMedia') return 'Paid media cannot be edited without changing access or payment terms.';
  if (type === 'MessageMediaToDo') return 'Checklist items and completion state are outside the supported edit matrix.';
  if (type === 'MessageMediaPoll') return 'Use close_poll to close a poll or quiz. Changes to its question, answers and votes are unsupported.';
  if (post.richMessage) return 'The gateway cannot safely resubmit rich-message content.';
  return undefined;
}
