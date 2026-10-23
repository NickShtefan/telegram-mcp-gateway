/** Secret-free setup contracts. Never surface parser errors or raw adapter errors. */
import { z } from 'zod';

export const setupIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const clientSchema = z.enum(['none', 'codex', 'claude', 'opencode', 'hermes']);
export type ClientSelection = z.infer<typeof clientSchema>;
export const errorSchema = z.enum([
  'invalid_request', 'unsupported_platform', 'unsupported_architecture', 'port_unavailable',
  'unsupported_os_version',
  'inspection_failed', 'existing_installation_requires_review',
  'invalid_state', 'adapter_failed', 'protection_unverified',
]);
export type SetupErrorCode = z.infer<typeof errorSchema>;

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode) { super(code); }
}

export function parseSafe<T>(schema: z.ZodType<T>, value: unknown, code: SetupErrorCode = 'invalid_state'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SetupError(code);
  return result.data;
}

export function safeError(err: unknown): SetupErrorCode {
  return err instanceof SetupError && errorSchema.safeParse(err.code).success ? err.code : 'adapter_failed';
}
