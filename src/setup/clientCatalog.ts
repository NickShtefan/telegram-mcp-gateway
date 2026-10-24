/** Default local profiles supported by the owner wizard. No client is selected implicitly. */
import { z } from 'zod';

export const CLIENT_KINDS = ['codex', 'claude', 'cursor', 'hermes', 'opencode', 'openclaw'] as const;
export type ClientKind = typeof CLIENT_KINDS[number];
export const CLIENT_LABELS: Record<ClientKind, string> = {
  codex: 'Codex Desktop/CLI', claude: 'Claude Code', cursor: 'Cursor', hermes: 'Hermes', opencode: 'OpenCode', openclaw: 'OpenClaw',
};
export const clientListSchema = z.array(z.enum(CLIENT_KINDS)).max(CLIENT_KINDS.length)
  .refine(clients => new Set(clients).size === clients.length);
