/** Default local profiles supported by the owner wizard. No client is selected implicitly. */
import { z } from 'zod';

export const CLIENT_KINDS = ['codex', 'claude', 'cursor', 'hermes', 'opencode', 'openclaw'] as const;
export type ClientKind = typeof CLIENT_KINDS[number];
export const CLIENT_LABELS: Record<ClientKind, string> = {
  codex: 'Codex Desktop/CLI', claude: 'Claude Code', cursor: 'Cursor', hermes: 'Hermes', opencode: 'OpenCode', openclaw: 'OpenClaw',
};
export const CLIENT_RESTART: Record<ClientKind, string> = {
  codex: 'Completely quit and reopen Codex Desktop, or exit and start a new Codex CLI session.',
  claude: 'Exit Claude Code and start a new Claude Code session.',
  cursor: 'Completely quit and reopen Cursor.',
  hermes: 'Restart the Hermes process or service on the machine where Hermes runs, then start a fresh conversation. Closing Telegram on your phone does not restart Hermes.',
  opencode: 'Exit OpenCode and start a new OpenCode session.',
  openclaw: 'Restart the OpenClaw gateway process or service on the machine where it runs, then start a fresh conversation.',
};
export const clientListSchema = z.array(z.enum(CLIENT_KINDS)).max(CLIENT_KINDS.length)
  .refine(clients => new Set(clients).size === clients.length);
