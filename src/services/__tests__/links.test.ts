import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../core/errors.js';
import { isValidUsername, messageLink, parseRef, type ParsedRef } from '../links.js';

const CHANNEL_KEY = '-1001782171896';
const CHANNEL_ID = '1782171896';

const username = (name: string, rest: Omit<ParsedRef, 'chat'> = {}): ParsedRef => ({ chat: { type: 'username', username: name }, ...rest });
const peer = (key: string, rest: Omit<ParsedRef, 'chat'> = {}): ParsedRef => ({ chat: { type: 'peer', peerKey: key }, ...rest });
const invite = (hash: string): ParsedRef => ({ chat: { type: 'invite', hash } });

/** Verifies INVALID_ARGUMENT and returns the error message. */
function rejectMessage(input: string): string {
  try {
    parseRef(input);
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe('INVALID_ARGUMENT');
    return (err as GatewayError).message;
  }
  throw new Error(`expected parseRef to throw for ${JSON.stringify(input)}`);
}

describe('isValidUsername', () => {
  it.each([
    ['durov'],
    ['abcd'],
    ['Durov_Channel'],
    ['a1_b2'],
    ['telegram'],
    ['a'.repeat(32)],
    ['some_bot'],
    ['x123'],
  ])('accepts %s', value => {
    expect(isValidUsername(value)).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['abc', 'shorter than 4 characters'],
    ['a'.repeat(33), 'longer than 32 characters'],
    ['1durov', 'starts with a digit'],
    ['_durov', 'starts with an underscore'],
    ['durov_', 'ends with an underscore'],
    ['@durov', 'includes @'],
    ['du-rov', 'hyphen'],
    ['du.rov', 'dot'],
    ['du rov', 'space'],
    ['dúrov', 'non-ASCII letters'],
    ['durov\n', 'trailing newline'],
  ])('rejects %j (%s)', value => {
    expect(isValidUsername(value)).toBe(false);
  });

  it('handles non-string values without crashing', () => {
    expect(isValidUsername(undefined as unknown as string)).toBe(false);
    expect(isValidUsername(12345 as unknown as string)).toBe(false);
  });
});

describe('parseRef: usernames and numeric IDs', () => {
  it.each<[string, ParsedRef]>([
    ['@durov', username('durov')],
    ['durov', username('durov')],
    ['  @durov  ', username('durov')],
    ['\tdurov\n', username('durov')],
    ['@Durov_Channel', username('Durov_Channel')],
    ['DuRoV', username('DuRoV')],
    ['@abcd', username('abcd')],
    // Reserved words are forbidden only as the first link path segment.
    ['@share', username('share')],
  ])('username: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each<[string, ParsedRef]>([
    ['-1001782171896', peer('-1001782171896')],
    ['-4321', peer('-4321')],
    ['777000', peer('777000')],
    [' 777000 ', peer('777000')],
    ['1', peer('1')],
    ['0042', peer('42')],
    ['-9008199254740993', peer('-9008199254740993')],
  ])('marked ID: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each([['0'], ['-0'], ['000']])('zero is not an ID: %j', input => {
    expect(rejectMessage(input)).toMatch(/must not be zero/);
  });

  it.each([['@abc'], ['abc'], ['@durov_'], ['@1durov'], ['@'], ['@@durov'], ['@du-rov'], ['durov_'], ['_durov'], ['a'.repeat(33)]])(
    'invalid username: %j',
    input => {
      expect(rejectMessage(input)).toMatch(/username/);
    },
  );
});

describe('parseRef: public t.me links', () => {
  it.each<[string, ParsedRef]>([
    ['t.me/durov', username('durov')],
    ['https://t.me/durov', username('durov')],
    ['http://t.me/durov', username('durov')],
    ['https://t.me/durov/', username('durov')],
    ['https://www.t.me/durov', username('durov')],
    ['www.t.me/durov', username('durov')],
    ['https://telegram.me/durov', username('durov')],
    ['telegram.me/durov/', username('durov')],
    ['https://telegram.dog/durov', username('durov')],
    ['HTTPS://T.ME/Durov', username('Durov')],
    ['  https://t.me/durov  ', username('durov')],
    ['https://t.me//durov//', username('durov')],
    ['https://t.me:443/durov', username('durov')],
    ['https://t.me/durov#fragment', username('durov')],
  ])('chat: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each<[string, ParsedRef]>([
    ['t.me/durov/123', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123/', username('durov', { messageId: 123 })],
    ['http://www.telegram.me/durov/123', username('durov', { messageId: 123 })],
    ['telegram.dog/durov/123', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123?single', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123/?single', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123?comment=45', username('durov', { messageId: 123, commentId: 45 })],
    ['https://t.me/durov/123?thread=7', username('durov', { messageId: 123, topicId: 7 })],
    ['https://t.me/durov/123?thread=7&comment=45', username('durov', { messageId: 123, topicId: 7, commentId: 45 })],
    ['https://t.me/durov/123?single&comment=45&t=30', username('durov', { messageId: 123, commentId: 45 })],
    ['https://t.me/durov/123#anchor', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123?comment=45#anchor', username('durov', { messageId: 123, commentId: 45 })],
    ['https://t.me/durov/2147483647', username('durov', { messageId: 2147483647 })],
    ['https://t.me/durov/0123', username('durov', { messageId: 123 })],
  ])('message: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each<[string, ParsedRef]>([
    ['t.me/forum_chat/7/123', username('forum_chat', { topicId: 7, messageId: 123 })],
    ['https://t.me/forum_chat/7/123/', username('forum_chat', { topicId: 7, messageId: 123 })],
    ['https://t.me/forum_chat/7/123?single', username('forum_chat', { topicId: 7, messageId: 123 })],
    ['https://t.me/forum_chat/7/123?comment=45', username('forum_chat', { topicId: 7, messageId: 123, commentId: 45 })],
    // A path topic takes precedence over a query topic.
    ['https://t.me/forum_chat/7/123?thread=9', username('forum_chat', { topicId: 7, messageId: 123 })],
    ['https://t.me/forum_chat?thread=7', username('forum_chat', { topicId: 7 })],
  ])('forum topic: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each<[string, ParsedRef]>([
    ['t.me/s/durov', username('durov')],
    ['https://t.me/s/durov/', username('durov')],
    ['https://t.me/s/durov/123', username('durov', { messageId: 123 })],
    ['https://t.me/s/durov/123?comment=45', username('durov', { messageId: 123, commentId: 45 })],
    ['https://t.me/s/durov?before=200', username('durov')],
    ['https://telegram.me/s/durov/123', username('durov', { messageId: 123 })],
  ])('web preview /s/: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each<[string, ParsedRef]>([
    ['https://t.me/some_bot?start=payload', username('some_bot')],
    ['https://t.me/some_bot?startgroup=abc', username('some_bot')],
    ['https://t.me/durov/123?t=42', username('durov', { messageId: 123 })],
    ['https://t.me/durov/123?foo=bar&single&baz', username('durov', { messageId: 123 })],
    ['https://t.me/durov?', username('durov')],
    ['https://t.me/durov?&&', username('durov')],
  ])('ignores unrelated parameters: %j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });
});

describe('parseRef: private t.me/c links', () => {
  it.each<[string, ParsedRef]>([
    [`t.me/c/${CHANNEL_ID}/123`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/123`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/123/`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`http://www.telegram.me/c/${CHANNEL_ID}/123`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/7/123`, peer(CHANNEL_KEY, { topicId: 7, messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/123?thread=7`, peer(CHANNEL_KEY, { topicId: 7, messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/123?comment=45`, peer(CHANNEL_KEY, { messageId: 123, commentId: 45 })],
    [`https://t.me/c/${CHANNEL_ID}/123?thread=7&comment=45`, peer(CHANNEL_KEY, { topicId: 7, messageId: 123, commentId: 45 })],
    [`https://t.me/c/${CHANNEL_ID}/7/123?thread=9`, peer(CHANNEL_KEY, { topicId: 7, messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}/123?single`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`https://t.me/c/${CHANNEL_ID}`, peer(CHANNEL_KEY)],
    ['https://t.me/c/1/5', peer('-1000000000001', { messageId: 5 })],
  ])('%j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each([
    ['https://t.me/c'],
    ['https://t.me/c/'],
    ['https://t.me/c/0/123'],
    ['https://t.me/c/abc/123'],
    ['https://t.me/c/durov/123'],
    [`https://t.me/c/-100${CHANNEL_ID}/123`],
    ['https://t.me/c/1.5/123'],
  ])('invalid channel ID: %j', input => {
    expect(rejectMessage(input)).toMatch(/bare channel id/);
  });

  it.each([
    [`https://t.me/c/${CHANNEL_ID}/abc`],
    [`https://t.me/c/${CHANNEL_ID}/0`],
    [`https://t.me/c/${CHANNEL_ID}/-5`],
    [`https://t.me/c/${CHANNEL_ID}/7/abc`],
    [`https://t.me/c/${CHANNEL_ID}/0/123`],
    [`https://t.me/c/${CHANNEL_ID}/1/2/3`],
    [`https://t.me/c/${CHANNEL_ID}/123?thread=0`],
    [`https://t.me/c/${CHANNEL_ID}/123?comment=x`],
    [`https://t.me/c/${CHANNEL_ID}?comment=45`],
  ])('invalid message, topic, or comment IDs: %j', input => {
    rejectMessage(input);
  });
});

describe('parseRef: invites', () => {
  it.each<[string, ParsedRef]>([
    ['t.me/+AbCdEf123', invite('AbCdEf123')],
    ['https://t.me/+AbCdEf123', invite('AbCdEf123')],
    ['https://t.me/+AbCdEf123/', invite('AbCdEf123')],
    ['https://t.me/+Ab-Cd_Ef123', invite('Ab-Cd_Ef123')],
    ['https://t.me/%2BAbCdEf123', invite('AbCdEf123')],
    ['https://telegram.me/+AbCdEf123', invite('AbCdEf123')],
    ['https://www.telegram.dog/+AbCdEf123', invite('AbCdEf123')],
    ['t.me/joinchat/AbCdEf123', invite('AbCdEf123')],
    ['https://t.me/joinchat/AbCdEf123', invite('AbCdEf123')],
    ['https://t.me/joinchat/AbCdEf123/', invite('AbCdEf123')],
    ['http://telegram.me/joinchat/AbCdEf123', invite('AbCdEf123')],
    ['https://t.me/joinchat/AAAAAEkk2WdoDrB4-Q8-gg', invite('AAAAAEkk2WdoDrB4-Q8-gg')],
    ['tg://join?invite=AbCdEf123', invite('AbCdEf123')],
    ['tg:join?invite=AbCdEf123', invite('AbCdEf123')],
    ['TG://JOIN?invite=AbCdEf123', invite('AbCdEf123')],
    ['  tg://join?invite=AbCdEf123  ', invite('AbCdEf123')],
  ])('%j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each([
    ['https://t.me/+', /no hash/],
    ['https://t.me/joinchat', /no hash/],
    ['https://t.me/joinchat/', /no hash/],
    ['tg://join', /no hash/],
    ['tg://join?invite=', /no hash/],
    ['https://t.me/+Ab$Cd', /not a valid invite hash/],
    ['https://t.me/joinchat/Ab.Cd', /not a valid invite hash/],
    ['tg://join?invite=Ab Cd', /not a valid invite hash/],
    ['https://t.me/+AbCdEf123/123', /after the invite hash/],
    ['https://t.me/joinchat/AbCdEf123/123', /after the invite hash/],
    ['https://t.me/+79991234567', /phone number/],
  ])('rejects %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });
});

describe('parseRef: deep links tg://', () => {
  it.each<[string, ParsedRef]>([
    ['tg://resolve?domain=durov', username('durov')],
    ['tg:resolve?domain=durov', username('durov')],
    ['TG://Resolve?domain=Durov', username('Durov')],
    ['tg://resolve/?domain=durov', username('durov')],
    ['tg://resolve?domain=durov&post=123', username('durov', { messageId: 123 })],
    ['tg://resolve?domain=durov&post=123&thread=7&comment=45', username('durov', { messageId: 123, topicId: 7, commentId: 45 })],
    ['tg://resolve?post=123&domain=durov&single', username('durov', { messageId: 123 })],
    ['tg://resolve?domain=durov&thread=7', username('durov', { topicId: 7 })],
    ['tg://resolve?domain=some_bot&start=payload', username('some_bot')],
    [`tg://privatepost?channel=${CHANNEL_ID}&post=123`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`tg://privatepost?channel=${CHANNEL_ID}&post=123&thread=7`, peer(CHANNEL_KEY, { messageId: 123, topicId: 7 })],
    [`tg://privatepost?channel=${CHANNEL_ID}&post=123&comment=45`, peer(CHANNEL_KEY, { messageId: 123, commentId: 45 })],
    [`tg://privatepost?post=123&channel=${CHANNEL_ID}`, peer(CHANNEL_KEY, { messageId: 123 })],
    [`tg://privatepost?channel=${CHANNEL_ID}`, peer(CHANNEL_KEY)],
  ])('%j', (input, expected) => {
    expect(parseRef(input)).toStrictEqual(expected);
  });

  it.each([
    ['tg://resolve', /domain/],
    ['tg://resolve?domain=', /domain/],
    ['tg://resolve?phone=79991234567', /domain/],
    ['tg://resolve?domain=abc', /username/],
    ['tg://resolve?domain=durov_', /username/],
    ['tg://resolve?domain=durov&post=0', /positive integer|between 1/],
    ['tg://resolve?domain=durov&post=abc', /positive integer/],
    ['tg://resolve?domain=durov&post=123&thread=x', /positive integer/],
    ['tg://resolve?domain=durov&post=123&comment=-1', /positive integer/],
    ['tg://resolve?domain=durov&comment=45', /without a post id/],
    ['tg://privatepost?post=123', /bare channel id/],
    ['tg://privatepost?channel=0&post=123', /bare channel id/],
    ['tg://privatepost?channel=durov&post=123', /bare channel id/],
    [`tg://privatepost?channel=${CHANNEL_ID}&post=`, /positive integer/],
    ['tg://msg?text=hello', /unsupported tg:\/\/ link/],
    ['tg://addstickers?set=abc', /unsupported tg:\/\/ link/],
    ['tg://', /unsupported tg:\/\/ link/],
  ])('rejects %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });
});

describe('parseRef: rejected inputs', () => {
  it.each([
    ['joinchat'],
    ['addstickers'],
    ['addemoji'],
    ['addlist'],
    ['share'],
    ['proxy'],
    ['socks'],
    ['login'],
    ['iv'],
    ['boost'],
    ['setlanguage'],
    ['addtheme'],
    ['bg'],
    ['invoice'],
    ['giftcode'],
    ['m'],
    ['s'],
  ])('reserved t.me/%s segment', segment => {
    rejectMessage(`https://t.me/${segment}`);
    rejectMessage(`https://t.me/${segment}/`);
    rejectMessage(`https://t.me/s/${segment}`);
    // t.me/joinchat/HASH and t.me/s/USERNAME are valid forms tested above.
    if (segment !== 'joinchat' && segment !== 's') rejectMessage(`https://t.me/${segment}/durov`);
  });

  it.each([
    ['https://t.me/addstickers/SomePack', /special Telegram link/],
    ['https://t.me/share/url?url=https://example.com', /special Telegram link/],
    ['https://t.me/Share', /special Telegram link/],
    ['https://t.me/boost/durov', /special Telegram link/],
    ['https://t.me/s/c/1782171896/123', /special Telegram link/],
    ['https://t.me/s', /no username/],
    ['https://t.me/s/', /no username/],
  ])('service link: %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });

  it.each([
    ['https://t.me/durov/abc', /message id must be a positive integer/],
    ['https://t.me/durov/0', /message id must be between 1/],
    ['https://t.me/durov/-5', /message id must be a positive integer/],
    ['https://t.me/durov/1.5', /message id must be a positive integer/],
    ['https://t.me/durov/99999999999', /message id must be a positive integer/],
    ['https://t.me/durov/2147483648', /message id must be between 1/],
    ['https://t.me/durov/abc/123', /topic id must be a positive integer/],
    ['https://t.me/durov/0/123', /topic id must be between 1/],
    ['https://t.me/durov/7/abc', /message id must be a positive integer/],
    ['https://t.me/durov/1/2/3', /too many path segments/],
    ['https://t.me/durov/123?comment=0', /comment id must be between 1/],
    ['https://t.me/durov/123?comment=abc', /comment id must be a positive integer/],
    ['https://t.me/durov/123?comment=', /comment id must be a positive integer/],
    ['https://t.me/durov/123?comment', /comment id must be a positive integer/],
    ['https://t.me/durov/123?thread=0', /thread \(topic id\) must be between 1/],
    ['https://t.me/durov/123?thread=-7', /thread \(topic id\) must be a positive integer/],
    ['https://t.me/durov?comment=45', /without a post id/],
    ['https://t.me/some_bot/appname', /message id must be a positive integer/],
  ])('invalid IDs: %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });

  it.each([
    ['https://t.me/abc', /username/],
    ['https://t.me/durov_', /username/],
    ['https://t.me/1durov', /username/],
    ['https://t.me/@durov', /username/],
    ['https://t.me/$invoice123', /username/],
    ['https://t.me/s/abc', /username/],
    ['https://t.me', /no chat/],
    ['https://t.me/', /no chat/],
    ['t.me', /no chat/],
    ['https://t.me/?start=1', /no chat/],
  ])('invalid chat in a link: %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });

  it.each([
    ['https://example.com/durov', /not a Telegram host/],
    ['example.com/durov/123', /not a Telegram host/],
    ['https://t.me.evil.com/durov', /not a Telegram host/],
    ['https://evil-t.me/durov', /not a Telegram host/],
    ['https://web.telegram.org/k/#@durov', /not a Telegram host/],
    ['https://durov.t.me', /not a Telegram host/],
    ['ftp://t.me/durov', /unsupported link scheme/],
    ['ton://t.me/durov', /unsupported link scheme/],
    ['', /empty/],
    ['   ', /empty/],
    ['\n\t', /empty/],
    ['hello world', /not a username, a numeric chat id or a Telegram link/],
    ['Dúrov', /not a username, a numeric chat id or a Telegram link/],
    ['+79991234567', /not a username, a numeric chat id or a Telegram link/],
    ['12.5', /not a Telegram host|not a username/],
    ['1e5', /username/],
    ['-', /not a username, a numeric chat id or a Telegram link/],
    ['//', /not a username, a numeric chat id or a Telegram link/],
    ['/durov/123', /not a username, a numeric chat id or a Telegram link/],
    ['durov/123', /not a username, a numeric chat id or a Telegram link/],
    ['?comment=5', /not a username, a numeric chat id or a Telegram link/],
  ])('garbage and unrelated hosts: %j', (input, pattern) => {
    expect(rejectMessage(input)).toMatch(pattern);
  });

  it('lists accepted forms in the error message', () => {
    const message = rejectMessage('hello world');
    expect(message).toContain('Accepted forms');
    expect(message).toContain('@username');
    expect(message).toContain('https://t.me/c/CHANNEL_ID/MESSAGE_ID');
    expect(message).toContain('tg://resolve');
    expect(message).toContain('"hello world"');
  });

  it('truncates long input in error messages', () => {
    const message = rejectMessage(`https://example.com/${'x'.repeat(5000)}`);
    expect(message.length).toBeLessThan(1500);
  });

  it('returns INVALID_ARGUMENT rather than TypeError for non-string values', () => {
    for (const value of [undefined, null, 123, {}]) {
      try {
        parseRef(value as unknown as string);
        throw new Error('expected parseRef to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).code).toBe('INVALID_ARGUMENT');
      }
    }
  });

  it('uses no em dash in error messages', () => {
    const dash = String.fromCharCode(0x2014);
    for (const input of ['', 'hello world', 'https://t.me/durov/abc', 'https://example.com/x', 'tg://msg', 'https://t.me/share']) {
      expect(rejectMessage(input)).not.toContain(dash);
    }
  });
});

describe('messageLink', () => {
  it.each<[Parameters<typeof messageLink>[0], string | null]>([
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123 }, 'https://t.me/durov/123'],
    [{ username: '@durov', peerKey: CHANNEL_KEY, messageId: 123 }, 'https://t.me/durov/123'],
    [{ username: 'Durov_Channel', peerKey: CHANNEL_KEY, messageId: 1 }, 'https://t.me/Durov_Channel/1'],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, topicId: 7 }, 'https://t.me/durov/7/123'],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, commentId: 45 }, 'https://t.me/durov/123?comment=45'],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, topicId: 7, commentId: 45 }, 'https://t.me/durov/7/123?comment=45'],
    [{ peerKey: CHANNEL_KEY, messageId: 123 }, `https://t.me/c/${CHANNEL_ID}/123`],
    [{ username: null, peerKey: CHANNEL_KEY, messageId: 123 }, `https://t.me/c/${CHANNEL_ID}/123`],
    [{ username: '', peerKey: CHANNEL_KEY, messageId: 123 }, `https://t.me/c/${CHANNEL_ID}/123`],
    [{ username: undefined, peerKey: CHANNEL_KEY, messageId: 123, topicId: 7 }, `https://t.me/c/${CHANNEL_ID}/7/123`],
    [{ peerKey: CHANNEL_KEY, messageId: 123, commentId: 45 }, `https://t.me/c/${CHANNEL_ID}/123?comment=45`],
    [{ peerKey: CHANNEL_KEY, messageId: 123, topicId: 7, commentId: 45 }, `https://t.me/c/${CHANNEL_ID}/7/123?comment=45`],
    // Channel ID exceeds 2^53: -(10^12 + 9007199254740993).
    [{ peerKey: '-9008199254740993', messageId: 5 }, 'https://t.me/c/9007199254740993/5'],
    // Invalid usernames are not used in links; fall back to /c/.
    [{ username: 'ab', peerKey: CHANNEL_KEY, messageId: 123 }, `https://t.me/c/${CHANNEL_ID}/123`],
    // Omit invalid optional IDs.
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, topicId: 0, commentId: -1 }, 'https://t.me/durov/123'],
  ])('channel or supergroup link: %j', (target, expected) => {
    expect(messageLink(target)).toBe(expected);
  });

  it.each<[Parameters<typeof messageLink>[0]]>([
    [{ peerKey: '777000', messageId: 123 }],
    [{ peerKey: '-4321', messageId: 123 }],
    [{ username: null, peerKey: '777000', messageId: 123 }],
    // Private chats and basic groups have no message links, even with usernames.
    [{ username: 'some_bot', peerKey: '777000', messageId: 123 }],
    [{ username: 'durov', peerKey: '-4321', messageId: 123 }],
    [{ username: 'durov', peerKey: 'garbage', messageId: 123 }],
    [{ username: 'durov', peerKey: '', messageId: 123 }],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 0 }],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: -5 }],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 1.5 }],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: Number.NaN }],
    [{ peerKey: CHANNEL_KEY, messageId: 2147483648 }],
  ])('null when no link exists: %j', target => {
    expect(messageLink(target)).toBeNull();
  });
});

describe('parseRef(messageLink(...)) round trip', () => {
  it.each<[Parameters<typeof messageLink>[0], ParsedRef]>([
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123 }, username('durov', { messageId: 123 })],
    [{ username: 'Durov_Channel', peerKey: CHANNEL_KEY, messageId: 2147483647 }, username('Durov_Channel', { messageId: 2147483647 })],
    [{ username: 'forum_chat', peerKey: CHANNEL_KEY, messageId: 123, topicId: 7 }, username('forum_chat', { messageId: 123, topicId: 7 })],
    [{ username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, commentId: 45 }, username('durov', { messageId: 123, commentId: 45 })],
    [
      { username: 'durov', peerKey: CHANNEL_KEY, messageId: 123, topicId: 7, commentId: 45 },
      username('durov', { messageId: 123, topicId: 7, commentId: 45 }),
    ],
    [{ peerKey: CHANNEL_KEY, messageId: 123 }, peer(CHANNEL_KEY, { messageId: 123 })],
    [{ peerKey: CHANNEL_KEY, messageId: 123, topicId: 7 }, peer(CHANNEL_KEY, { messageId: 123, topicId: 7 })],
    [{ peerKey: CHANNEL_KEY, messageId: 123, commentId: 45 }, peer(CHANNEL_KEY, { messageId: 123, commentId: 45 })],
    [{ peerKey: CHANNEL_KEY, messageId: 123, topicId: 7, commentId: 45 }, peer(CHANNEL_KEY, { messageId: 123, topicId: 7, commentId: 45 })],
    [{ peerKey: '-1000000000001', messageId: 1 }, peer('-1000000000001', { messageId: 1 })],
    [{ peerKey: '-9008199254740993', messageId: 5 }, peer('-9008199254740993', { messageId: 5 })],
  ])('%j', (target, expected) => {
    const link = messageLink(target);
    expect(link).not.toBeNull();
    expect(parseRef(link!)).toEqual(expected);
  });

  it.each([
    ['https://t.me/durov/123'],
    ['https://t.me/durov/7/123'],
    ['https://t.me/durov/123?comment=45'],
    ['https://t.me/durov/7/123?comment=45'],
    [`https://t.me/c/${CHANNEL_ID}/123`],
    [`https://t.me/c/${CHANNEL_ID}/7/123`],
    [`https://t.me/c/${CHANNEL_ID}/123?comment=45`],
  ])('round trip rebuilds link %s unchanged', link => {
    const ref = parseRef(link);
    expect(ref.messageId).toBeDefined();
    const rebuilt = messageLink({
      username: ref.chat.type === 'username' ? ref.chat.username : null,
      // Username references need resolution for actual IDs; use any channel here.
      peerKey: ref.chat.type === 'peer' ? ref.chat.peerKey : CHANNEL_KEY,
      messageId: ref.messageId!,
      topicId: ref.topicId,
      commentId: ref.commentId,
    });
    expect(rebuilt).toBe(link);
  });
});
