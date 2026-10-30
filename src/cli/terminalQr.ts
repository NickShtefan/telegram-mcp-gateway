/** Private terminal QR display. Raw login URLs/tokens never reach progress or logs. */
import qrcode from 'qrcode-generator';
import type { TerminalOutput } from './terminalInput.js';

/** One terminal cell holds two vertically adjacent square QR modules. Includes a four-module quiet zone. */
export function terminalQrRows(token: string): string[] {
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new Error('Invalid QR display frame.');
  const qr = qrcode(0, 'M'); qr.addData(`tg://login?token=${token}`); qr.make();
  const size = qr.getModuleCount(); const extent = size + 8;
  const dark = (row: number, column: number): boolean => row >= 4 && column >= 4 && row < size + 4 && column < size + 4 && qr.isDark(row - 4, column - 4);
  const rows: string[] = [];
  for (let row = 0; row < extent; row += 2) {
    let line = '';
    for (let column = 0; column < extent; column++) {
      const top = dark(row, column); const bottom = dark(row + 1, column);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    rows.push(line);
  }
  return rows;
}

export interface TerminalQr { show(code: { token: string; expires: number }): boolean; clear(): void; }
export function createTerminalQr(output: TerminalOutput, env: NodeJS.ProcessEnv = process.env): TerminalQr {
  let displayed = 0; let instructions = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const erase = (): void => {
    if (timer) clearTimeout(timer); timer = undefined;
    while (displayed > 0) { output.write('\u001b[1A\r\u001b[2K'); displayed--; }
    output.off('resize', resized);
  };
  const resized = (): void => {
    // Width/height reflow can split a code into many physical rows. Clear the
    // visible view so a cropped old QR never remains available for scanning.
    if (timer) clearTimeout(timer); timer = undefined; output.off('resize', resized);
    displayed = 0; instructions = false; output.write('\u001b[2J\u001b[H');
    output.write('Window resized. Waiting for refresh.'.slice(0, Math.max(1, (output.columns ?? 80) - 1)) + '\n'); displayed = 1;
  };
  return {
    clear: () => { erase(); instructions = false; },
    show: code => {
      erase();
      if (!Number.isSafeInteger(code.expires) || code.expires <= 0) throw new Error('Invalid QR display frame.');
      const rows = terminalQrRows(code.token);
      // Never wrap/crop a code. ANSI black-on-white is functional contrast, including NO_COLOR sessions.
      if (!output.isTTY || env.TERM === 'dumb' || !Number.isInteger(output.columns) || !Number.isInteger(output.rows)
        || rows[0]!.length >= output.columns! || rows.length + 1 >= output.rows!) return false;
      if (!instructions) {
        output.write('Open Telegram on your phone: Settings > Devices > Link Desktop Device.\nScan the code below. It refreshes automatically. Ctrl+C cancels setup.\n');
        instructions = true;
      }
      const until = code.expires * 1000 - Date.now();
      if (until <= 0) { output.write('QR code expired. Waiting...\n'); displayed = 1; return true; }
      for (const row of rows) { output.write('\u001b[30;47m' + row + '\u001b[0m\n'); displayed++; }
      output.write('Scan with Telegram. Ctrl+C cancels.\n'); displayed++;
      output.once('resize', resized);
      timer = setTimeout(() => { erase(); output.write('QR code expired. Waiting...\n'); displayed = 1; }, Math.min(until, 600000));
      timer.unref(); return true;
    },
  };
}
