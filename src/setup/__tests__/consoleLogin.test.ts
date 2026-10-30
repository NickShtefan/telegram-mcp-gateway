import { describe, expect, it, vi } from 'vitest';
import { getActiveResourcesInfo } from 'node:process';
import type { CliIo } from '../../cli/io.js';
import { consoleOwnerLogin } from '../consoleLogin.js';

const signal = new AbortController().signal;
const code = { token: Buffer.from('synthetic console private token').toString('base64url'), expires: 2000000000 };
describe('owner console login UI', () => {
  it('selects terminal QR without a listener, clears it before 2FA and keeps values out of progress', async () => {
    const before = getActiveResourcesInfo().filter(type => type === 'TCPServerWrap').length; const events: string[] = [];
    let cancel!: () => void;
    const io: CliIo = { out: vi.fn(), err: vi.fn(),
      prompt: vi.fn(async (question, options) => { events.push('prompt');
        expect(options?.hidden).toBe(question.includes('password')); return 'fixture-value'; }),
      select: vi.fn(async () => ['qr']), qr: vi.fn(() => { events.push('qr'); return true; }),
      clearQr: vi.fn(() => { events.push('clear'); }), cancelControl: callback => { cancel = callback; return () => { events.push('stop-control'); }; } };
    const ui = consoleOwnerLogin(io);
    expect(await ui.answer('login_method', signal)).toBe('qr'); ui.qr(code); ui.qr({ ...code, expires: code.expires + 30 });
    await ui.answer('password', signal); expect(events.slice(-3)).toEqual(['stop-control', 'clear', 'prompt']);
    expect(io.qr).toHaveBeenCalledTimes(2); expect(io.err).not.toHaveBeenCalled(); expect(io.out).not.toHaveBeenCalled();
    ui.qr(code); cancel(); expect(ui.signal.aborted).toBe(true); expect(events.at(-1)).toBe('clear'); await ui.close();
    expect(getActiveResourcesInfo().filter(type => type === 'TCPServerWrap')).toHaveLength(before);
  });
  it('retains API values in memory while unscannable QR falls back only through a stopped-attempt retry', async () => {
    const io: CliIo = { out: vi.fn(), err: vi.fn(), prompt: vi.fn(async question => question.includes('id') ? '12345' : 'a'.repeat(32)),
      select: vi.fn(async () => ['qr']), qr: vi.fn(() => false), clearQr: vi.fn() };
    const ui = consoleOwnerLogin(io); await ui.answer('api_id', signal); await ui.answer('api_hash', signal);
    expect(await ui.answer('login_method', signal)).toBe('qr'); ui.qr(code); expect(ui.signal.aborted).toBe(true);
    ui.finish(false); expect(await ui.takeRetry!()).toEqual({ mode: 'console', method: 'phone' });
    expect(ui.signal.aborted).toBe(false); expect(await ui.answer('api_id', signal)).toBe('12345');
    expect(await ui.answer('api_hash', signal)).toBe('a'.repeat(32)); expect(io.prompt).toHaveBeenCalledTimes(2);
    expect(await ui.answer('login_method', signal)).toBe('phone'); expect(io.select).toHaveBeenCalledOnce();
    for (const secret of [code.token, 'tg://', 'a'.repeat(32)]) expect(JSON.stringify((io.err as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(secret);
    await ui.close();
  });
  it('keeps a safe phone-only fallback for compatibility IO without terminal QR capability', async () => {
    const io: CliIo = { out: vi.fn(), err: vi.fn(), prompt: vi.fn(async () => '') };
    const ui = consoleOwnerLogin(io); expect(await ui.answer('login_method', signal)).toBe('phone'); expect(io.prompt).not.toHaveBeenCalled(); await ui.close();
  });
});
