import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import qrcode from 'qrcode-generator';
import { createTerminalQr, terminalQrRows } from '../terminalQr.js';
import type { TerminalOutput } from '../terminalInput.js';

const token = Buffer.from('synthetic private QR token one').toString('base64url');
function fixture(columns = 100, rows = 50) {
  const output = new PassThrough() as PassThrough & TerminalOutput; output.isTTY = true; output.columns = columns; output.rows = rows;
  const text: string[] = []; output.on('data', data => text.push(data.toString()));
  return { output, text };
}
afterEach(() => vi.useRealTimers());
describe('private terminal QR display', () => {
  it('encodes an intact QR with a four-module quiet zone and correct half-cell orientation', () => {
    const rows = terminalQrRows(token); const decoded: boolean[][] = [];
    for (const row of rows) {
      decoded.push([...row].map(cell => cell === '█' || cell === '▀'));
      decoded.push([...row].map(cell => cell === '█' || cell === '▄'));
    }
    const qr = qrcode(0, 'M'); qr.addData(`tg://login?token=${token}`); qr.make(); const size = qr.getModuleCount();
    expect(rows[0].length).toBe(size + 8);
    for (let row = 0; row < decoded.length; row++) for (let column = 0; column < size + 8; column++) {
      const inside = row >= 4 && column >= 4 && row < size + 4 && column < size + 4;
      expect(decoded[row][column], `module ${row}:${column}`).toBe(inside && qr.isDark(row - 4, column - 4));
    }
    expect(rows.join('')).not.toContain(token); expect(rows.join('')).not.toContain('tg://');
  });
  it('refreshes in place with fixed black/white contrast and clears on expiry or completion', () => {
    vi.useFakeTimers(); const f = fixture(); const renderer = createTerminalQr(f.output, { TERM: 'xterm', NO_COLOR: '1' });
    const expires = Math.floor(Date.now() / 1000) + 2;
    expect(renderer.show({ token, expires })).toBe(true); expect(f.text.join('')).toContain('\u001b[30;47m');
    expect(f.text.join('')).toContain('Settings > Devices > Link Desktop Device');
    expect(renderer.show({ token: Buffer.from('synthetic private QR token two').toString('base64url'), expires })).toBe(true);
    expect(f.text.join('')).toContain('\u001b[1A\r\u001b[2K'); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000); expect(f.text.join('')).toContain('QR code expired');
    renderer.clear(); expect(vi.getTimerCount()).toBe(0); expect(f.output.listenerCount('resize')).toBe(0);
    for (const secret of [token, 'tg://login']) expect(f.text.join('')).not.toContain(secret);
  });
  it('refuses cropped or unsupported codes without printing any QR or raw value', () => {
    for (const [columns, rows, term] of [[20, 50, 'xterm'], [100, 10, 'xterm'], [100, 50, 'dumb']] as const) {
      const f = fixture(columns, rows); const renderer = createTerminalQr(f.output, { TERM: term });
      expect(renderer.show({ token, expires: Math.floor(Date.now() / 1000) + 30 })).toBe(false); expect(f.text).toEqual([]);
      expect(f.output.listenerCount('resize')).toBe(0); renderer.clear();
    }
  });
  it('clears the entire reflowed QR view on resize instead of leaving a clipped code', () => {
    const f = fixture(); const renderer = createTerminalQr(f.output, { TERM: 'xterm' });
    expect(renderer.show({ token, expires: Math.floor(Date.now() / 1000) + 30 })).toBe(true);
    f.output.columns = 20; f.output.emit('resize');
    expect(f.text.join('')).toContain('\u001b[2J\u001b[H');
    expect(renderer.show({ token, expires: Math.floor(Date.now() / 1000) + 30 })).toBe(false); renderer.clear();
  });
});
