/**
 * Reaction normalization: standard emoji keys are the emoji itself,
 * custom emoji use `custom:<id>`, paid reactions use `paid`.
 */

/** Api.ReactionEmoji, Api.ReactionCustomEmoji, or Api.ReactionPaid. */
interface ReactionLike {
  className?: string;
  emoticon?: string;
  documentId?: unknown;
}

export interface ReactionCount {
  reaction: string;
  count: number;
}

export function reactionKey(reaction: unknown): string {
  const r = reaction as ReactionLike | null | undefined;
  if (!r || typeof r !== 'object') return JSON.stringify(r ?? null);

  if (typeof r.emoticon === 'string' && r.emoticon) return r.emoticon;
  if (r.documentId !== undefined && r.documentId !== null) return `custom:${String(r.documentId)}`;
  if (r.className === 'ReactionPaid') return 'paid';

  return JSON.stringify(r);
}

interface MessageReactionsLike {
  results?: Array<{ reaction?: unknown; count?: unknown } | null | undefined>;
}

/** teleproto `message.reactions` -> counters in descending order. */
export function normalizeReactions(messageReactions: unknown): ReactionCount[] {
  const mr = messageReactions as MessageReactionsLike | null | undefined;
  if (!mr || !Array.isArray(mr.results) || mr.results.length === 0) return [];
  const out: ReactionCount[] = [];
  for (const result of mr.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      out.push({ reaction: reactionKey(result.reaction), count: result.count });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

export function totalReactions(reactions: ReactionCount[]): number {
  return reactions.reduce((sum, r) => sum + r.count, 0);
}
