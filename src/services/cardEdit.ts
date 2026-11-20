import { GatewayError } from '../core/errors.js';
import { entityFingerprints, type PostEditState, type PostTarget, type semanticFields } from './linkEdit.js';
import { coverageEntities } from './postEntities.js';
import { cardFields, cardUrls, checkSize, httpUrl, type CardInfo, type CardSettings, type Position, type Size } from './webPreview.js';

export const CARD_EDIT = 'set_link_preview';
export interface CardArgs { preview_mode?: 'preserve' | 'enable' | 'disable'; preview_url?: string; preview_size?: Size; preview_position?: Position }
export interface CardPlan extends PostTarget {
  op: typeof CARD_EDIT; version: 1; telegramUserId: string; revision: string;
  after: CardSettings | null;
  /** Approved input URL when Telegram must explicitly select or reconfigure a card. */
  inputUrl?: string;
  probeUrl?: string;
  expected: ReturnType<typeof semanticFields>;
}

function refuse(reason: string): never { throw new GatewayError('INVALID_ARGUMENT', reason); }

export async function prepareCard(state: PostEditState, args: CardArgs, probe: (url: string) => Promise<CardInfo>) {
  const info = state.card;
  if (info.kind === 'unavailable') refuse(info.reason);
  const before = info.kind === 'ready' ? info.settings : null;
  const mode = args.preview_mode ?? (args.preview_url !== undefined ? 'enable' : 'preserve');
  const configured = args.preview_url !== undefined || args.preview_size !== undefined || args.preview_position !== undefined;
  if (mode === 'disable' && configured) refuse('Use disable alone, without URL, size or position.');
  if (mode === 'disable' && before && !state.post.message.trim()) refuse('This card is the only content of the post.');
  if (mode === 'preserve' && !before && configured) refuse('Use enable to configure a card on a post without one.');
  if (args.preview_url !== undefined && !httpUrl(args.preview_url)) refuse('preview_url must be an absolute HTTP or HTTPS URL.');
  let after = before;
  let inputUrl: string | undefined;
  let probeUrl: string | undefined;
  if (mode === 'disable') after = null;
  else if (mode === 'enable' || before) {
    let url = args.preview_url ?? before?.url;
    if (!url) {
      const candidates = cardUrls(state.post);
      if (candidates.length > 1) return { status: 'choose_url' as const, candidates: candidates.slice(0, 12), total: candidates.length };
      if (!candidates.length) refuse('Supply preview_url to select a card. No HTTP link was found in the post.');
      url = candidates[0];
    }
    const size = args.preview_size ?? before?.size ?? 'auto';
    const position = args.preview_position ?? before?.position ?? 'bottom';
    const select = !before || args.preview_url !== undefined || size !== before.size;
    let selected = before?.url ?? url;
    if (!before || url !== before.url) {
      probeUrl = url;
      selected = checkSize(await probe(url), size);
      if (new URL(selected).href !== new URL(url).href) {
        return { status: 'canonical_url_required' as const, requested_url: url, resolved_url: selected };
      }
    } else if (size !== before.size || position !== before.position || (args.preview_url !== undefined && !before.manual)) {
      checkSize(info, size);
    }
    after = { url: selected, size, position, manual: select || !!before?.manual };
    if (!after.manual && after.size !== 'auto' && position !== before?.position) {
      refuse('Select this URL explicitly before repositioning an automatic card with forced sizing.');
    }
    if (after.manual) inputUrl = url;
  }
  const expected = { ...state.fields, entities: entityFingerprints(coverageEntities(state.post.entities ?? [])) };
  delete expected.preview_state;
  delete expected.preview_url;
  delete expected.preview_size;
  delete expected.preview_manual;
  expected.media = after ? 'MessageMediaWebPage' : 'MessageMediaEmpty';
  expected.invert_media = after ? after.position === 'top' : before ? false : state.fields.invert_media;
  if (after) Object.assign(expected, cardFields({ kind: 'ready', settings: after, resizable: false }));
  const plan: CardPlan = { ...state.target, op: CARD_EDIT, version: 1, telegramUserId: state.telegramUserId,
    revision: state.revision, after, inputUrl, probeUrl, expected };
  return { status: 'preview' as const, before, after, plan };
}
