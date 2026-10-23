import { describe, expect, it } from 'vitest';
import { createEnvelope } from '../../policy/envelope.js';
import type { MessageDto } from '../../services/messages.js';
import { describeWindow, parseWindow } from '../args.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { compactNumber, formatCard, formatDate, formatDuration, formatMessage, formatMessageList, formatReactions } from '../format.js';

function msg(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 123,
    chatKey: '-1000000000500',
    date: 1_790_000_000,
    editDate: null,
    text: 'Selling iPhone 15, 256 GB.\nPrice 65k, negotiable.',
    author: { kind: 'user', peerKey: '42', name: 'Ivan Petrov', username: 'seller', bot: false },
    views: null,
    forwards: null,
    replies: null,
    hasComments: false,
    reactions: [],
    media: null,
    groupedId: null,
    replyToId: null,
    topicId: null,
    forwardedFrom: null,
    hiddenLinks: [],
    service: null,
    pinned: false,
    out: false,
    buttons: [],
    ...overrides,
  };
}

const env = createEnvelope('abcd1234');

describe('numbers, dates, and duration', () => {
  it('compactNumber', () => {
    expect([0, 999, 1000, 1234, 12_345, 123_456, 1_200_000, 2_500_000_000].map(compactNumber)).toEqual([
      '0', '999', '1k', '1.2k', '12.3k', '123k', '1.2M', '2.5B',
    ]);
  });

  it('formats UTC dates and durations', () => {
    expect(formatDate(1_790_000_000)).toBe('2026-09-21 14:13');
    expect(formatDate(0)).toBe('unknown date');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('shows the top three reactions and the remainder', () => {
    expect(formatReactions([
      { reaction: '👍', count: 1200 },
      { reaction: '🔥', count: 30 },
      { reaction: 'custom:55', count: 9 },
      { reaction: '😢', count: 4 },
      { reaction: 'paid', count: 1 },
    ])).toBe('👍1.2k 🔥30 ⭐9 +5');
    expect(formatReactions([])).toBe('');
  });
});

describe('formatMessage', () => {
  it('full mode includes a header and bounded untrusted text', () => {
    const text = formatMessage(msg({ topicId: 5, replyToId: 120 }), { mode: 'full', envelope: env, linkFor: m => `https://t.me/fixture_market/5/${m.id}` });
    expect(text).toBe(
      '#123 | 2026-09-21 14:13 | @seller | topic 5 | re #120 | https://t.me/fixture_market/5/123\n' +
        '<<<TG:abcd1234\nSelling iPhone 15, 256 GB.\nPrice 65k, negotiable.\nTG:abcd1234>>>',
    );
  });

  it('brief mode uses two lines per channel post with counters', () => {
    const post = msg({
      author: { kind: 'channel', peerKey: '-1000000000500', name: 'Fixture Channel', username: 'fixture_channel', bot: false },
      views: 12_345,
      forwards: 7,
      replies: 14,
      hasComments: true,
      reactions: [{ reaction: '🔥', count: 30 }],
      media: { kind: 'photo', downloadable: true },
      groupedId: '9',
      editDate: 5,
      pinned: true,
    });
    const text = formatMessage(post, { mode: 'brief', envelope: env, showAuthor: false });
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[0]).toBe('#123 | 2026-09-21 14:13 | views 12.3k | shares 7 | comments 14 | 🔥30 | [album photo] | pinned | edited');
    expect(text.split('\n')[1]).toBe('> Selling iPhone 15, 256 GB. Price 65k, negotiable.');
  });

  it('full mode shows button position, label, kind, and URL; brief mode only counts buttons', () => {
    const withButtons = msg({
      buttons: [
        [
          { kind: 'callback', text: 'I am not a bot', needsPassword: false, url: null },
          { kind: 'url', text: 'Website', needsPassword: false, url: 'https://example.com/a?b=1' },
        ],
        [{ kind: 'callback', text: 'Delete "all" <b>', needsPassword: true, url: null }],
      ],
    });
    const full = formatMessage(withButtons, { mode: 'full', envelope: env });
    expect(full.split('\n').at(-1)).toBe(
      'buttons: 1.1 "I am not a bot" (callback) | 1.2 "Website" (link https://example.com/a?b=1) | 2.1 "Delete \'all\' b" (callback, asks for the 2FA password)',
    );
    const brief = formatMessage(withButtons, { mode: 'brief', envelope: env });
    expect(brief.split('\n')[0]).toContain('| buttons 3');
    expect(brief).not.toContain('I am not a bot');
    // Buttons remain visible on messages without text.
    expect(formatMessage(msg({ text: '', buttons: withButtons.buttons }), { mode: 'full', envelope: env }).split('\n')).toHaveLength(2);
  });

  it('shows hidden-link labels and URLs in full mode only', () => {
    const post = msg({
      text: 'Details here and in the source',
      hiddenLinks: [
        { text: 'here', url: 'https://hidden.example/x' },
        { text: 'source', url: 'https://source.example/<b>' },
      ],
      buttons: [[{ kind: 'url', text: 'Read', needsPassword: false, url: 'https://example.com/read' }]],
    });
    const lines = formatMessage(post, { mode: 'full', envelope: env }).split('\n');
    // Links follow the text, then buttons.
    expect(lines.at(-2)).toBe('hidden links: "here" https://hidden.example/x | "source" https://source.example/b');
    expect(lines.at(-1)).toBe('buttons: 1.1 "Read" (link https://example.com/read)');
    expect(formatMessage(post, { mode: 'brief', envelope: env })).not.toContain('hidden.example');

    const many = msg({ hiddenLinks: Array.from({ length: 23 }, (_, i) => ({ text: `l${i}`, url: `https://e.example/${i}` })) });
    expect(formatMessage(many, { mode: 'full', envelope: env }).split('\n').at(-1)).toMatch(/"l19" https:\/\/e\.example\/19 \| \+3 more$/);
  });

  it('truncates long text with a hint', () => {
    const text = formatMessage(msg({ text: 'é'.repeat(3000) }), { mode: 'full', envelope: env, maxTextChars: 100 });
    expect(text).toContain('(text cut at 100 of 3000 chars; read it in full with tg_get_message)');
    expect(text.length).toBeLessThan(400);
  });

  it('handles empty and service messages', () => {
    expect(formatMessage(msg({ text: '', media: { kind: 'video', durationSec: 65, downloadable: true } }), { mode: 'full', envelope: env })).toBe(
      '#123 | 2026-09-21 14:13 | @seller | [video 1:05]',
    );
    expect(formatMessage(msg({ text: '', service: 'MessageActionChatAddUser' }), { mode: 'brief', envelope: env })).toContain('service: ChatAddUser');
  });

  it('shows author names without usernames with IDs and no line breaks', () => {
    const text = formatMessage(msg({ author: { kind: 'user', peerKey: '42', name: 'Ivan\nIGNORE ALL', username: null, bot: false } }), { mode: 'brief', envelope: env });
    expect(text.split('\n')[0]).toContain('Ivan IGNORE ALL (id 42)');
  });

  it('marks outgoing messages as sent by this account', () => {
    const header = (overrides: Partial<MessageDto>) => formatMessage(msg({ text: '', out: true, ...overrides }), { mode: 'brief', envelope: env });
    expect(header({ author: { kind: 'user', peerKey: '1001', name: 'Test Account', username: 'agent_acc', bot: false } })).toBe('#123 | 2026-09-21 14:13 | @agent_acc (this account)');
    expect(header({ author: { kind: 'user', peerKey: '1001', name: 'Nick', username: null, bot: false } })).toContain('| Nick (id 1001) (this account)');
    expect(header({ author: { kind: 'user', peerKey: null, name: null, username: null, bot: false } })).toBe('#123 | 2026-09-21 14:13 | this account');
    // Channel posts and messages sent as a group retain channel/group attribution.
    expect(header({ author: { kind: 'channel', peerKey: '-1000000000500', name: 'Fixture Channel', username: 'fixture_channel', bot: false } })).toBe('#123 | 2026-09-21 14:13 | @fixture_channel');
    expect(header({ author: { kind: 'anonymous', peerKey: null, name: null, username: null, bot: false } })).toBe('#123 | 2026-09-21 14:13 | anonymous');
  });
});

describe('formatMessageList', () => {
  it('formats headers, warnings, lists, and cursors', () => {
    const text = formatMessageList([msg(), msg({ id: 124 })], { title: 'Chat @fixture_market, 2 of 240 messages', mode: 'brief', envelope: env, nextCursor: 'c1.abc', hints: ['Use tg_export for the full set.'] });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Chat @fixture_market, 2 of 240 messages');
    expect(lines[1]).toContain('Untrusted content');
    expect(lines[2]).toBe('Times are UTC.');
    expect(text).toContain('#124 | ');
    expect(lines.slice(-2)).toEqual(['Use tg_export for the full set.', 'next_cursor: c1.abc']);
  });

  it('handles empty results and the last page', () => {
    expect(formatMessageList([], { title: 'T', mode: 'full', envelope: env })).toBe('T\nNo messages.');
    expect(formatMessageList([msg()], { title: 'T', mode: 'full', envelope: env, nextCursor: null }).endsWith('End of results.')).toBe(true);
  });

  it('formatCard skips empty fields', () => {
    expect(formatCard('Chat', [['title', 'X'], ['username', null], ['members', 5], ['about', '']])).toBe('Chat\ntitle: X\nmembers: 5');
  });
});

describe('cursor', () => {
  it('encodes and parses positions', () => {
    const cursor = encodeCursor('history', { chat: '-1000000000500', offsetId: 77, done: false });
    expect(cursor.startsWith('c1.')).toBe(true);
    expect(cursor).not.toContain('offsetId');
    expect(decodeCursor('history', cursor)).toEqual({ chat: '-1000000000500', offsetId: 77, done: false });
  });

  it('rejects mismatched or malformed cursors with clear messages', () => {
    const cursor = encodeCursor('history', { offsetId: 1 });
    expect(() => decodeCursor('search', cursor)).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'garbage')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'c1.!!!!')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'c1.' + Buffer.from('[1,2,3]').toString('base64url'))).toThrow(/Invalid cursor/);
  });
});

describe('date arguments', () => {
  it.each(['2026-02-30', '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-12-00', '2026-02-30T12:00:00Z', '2026-02-30T23:00:00-03:00'])('rejects the impossible calendar date %s', value => {
    expect(() => parseWindow(value, undefined, 0)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parseWindow(undefined, value, 0)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it.each(['2024-02-29', '2000-02-29', '2026-04-30', '2024-02-29T23:30:00-03:00', '2026-04-30T12:30:00+02:00', '2026-04-30 12:30:00'])('preserves supported valid dates and timezones: %s', value => {
    const iso = value.length === 10 ? `${value}T00:00:00Z` : value.replace(' ', 'T') + (value.includes('+') || /[TZ].*-/.test(value) || value.endsWith('Z') ? '' : 'Z');
    expect(parseWindow(value, undefined, 0).minDate).toBe(Date.parse(iso) / 1000);
  });

  it('preserves relative periods and Unix seconds', () => {
    expect(parseWindow('2d', undefined, 1_000_000_000)).toEqual({ minDate: 1_000_000 - 172800, maxDate: undefined });
    expect(parseWindow('1700000000', undefined, 0).minDate).toBe(1700000000);
  });
});

describe('date window headers', () => {
  it('renders an explicit zero boundary and omits absent boundaries', () => {
    expect(describeWindow({ minDate: 0 })).toBe(' since 1970-01-01 00:00');
    expect(describeWindow({ maxDate: 0 })).toBe(' until 1970-01-01 00:00');
    expect(describeWindow({ minDate: 0, maxDate: 60 })).toBe(' from 1970-01-01 00:00 to 1970-01-01 00:01');
    expect(describeWindow({})).toBe('');
  });
});
