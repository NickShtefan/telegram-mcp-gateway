import { describe, expect, it } from 'vitest';
import { isBotApiChannelId, looksLikePeerKey, parsePeerKey, peerKey, toBotApiChatId, toMtprotoChannelId } from '../chatId.js';

describe('chatId', () => {
  it('converts channel IDs between representations', () => {
    expect(toBotApiChatId(1782171896)).toBe('-1001782171896');
    expect(toBotApiChatId('1782171896')).toBe('-1001782171896');
    expect(toMtprotoChannelId('-1001782171896')).toBe(1782171896n);
    expect(toMtprotoChannelId(-1001782171896)).toBe(1782171896n);
  });

  it('rejects invalid representations', () => {
    expect(() => toBotApiChatId(-5)).toThrow();
    expect(() => toBotApiChatId('abc')).toThrow();
    expect(() => toMtprotoChannelId(-123)).toThrow();
    expect(() => toMtprotoChannelId(1.5)).toThrow();
  });

  it('peerKey and parsePeerKey are inverses', () => {
    const cases = [
      { kind: 'user' as const, id: 777000n, key: '777000' },
      { kind: 'chat' as const, id: 4321n, key: '-4321' },
      { kind: 'channel' as const, id: 1782171896n, key: '-1001782171896' },
    ];
    for (const c of cases) {
      expect(peerKey(c)).toBe(c.key);
      expect(parsePeerKey(c.key)).toEqual({ kind: c.kind, id: c.id });
    }
  });

  it('preserves IDs above 2^53', () => {
    const big = 9007199254740993n;
    expect(parsePeerKey(peerKey({ kind: 'user', id: big }))).toEqual({ kind: 'user', id: big });
  });

  it('identifies the ID representation', () => {
    expect(isBotApiChannelId('-1001782171896')).toBe(true);
    expect(isBotApiChannelId('-4321')).toBe(false);
    expect(looksLikePeerKey('-1001782171896')).toBe(true);
    expect(looksLikePeerKey('@durov')).toBe(false);
    expect(() => parsePeerKey('0')).toThrow();
  });
});
