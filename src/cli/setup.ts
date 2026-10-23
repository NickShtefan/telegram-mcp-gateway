/** Setup commands bypass loadConfig, storage and login. No privileged mutations. */
import { parseArgs } from 'node:util';
import type { CliIo } from './io.js';
import { preflight, type PreflightProbe } from '../setup/preflight.js';
import { clientSchema, parseSafe, safeError, SetupError } from '../setup/contract.js';

export interface SetupCliDeps {
  probe?: PreflightProbe;
}

export async function runSetup(args: string[], io: CliIo, deps: SetupCliDeps = {}): Promise<number> {
  try {
    const [sub, ...rest] = args;
    if (sub === 'preflight') {
      const { values } = parseArgs({ args: rest, options: {
        json: { type: 'boolean' }, port: { type: 'string' }, client: { type: 'string' },
      } });
      if (values.port !== undefined && !/^\d{1,5}$/.test(values.port)) throw new SetupError('invalid_request');
      const result = await preflight({ port: Number(values.port ?? 7777), client: parseSafe(clientSchema, values.client ?? 'none', 'invalid_request') }, deps.probe);
      io.out(values.json ? JSON.stringify(result) : [
        `Setup preflight: ${result.phase}.`,
        `Artifact: verified macOS package required; Node is installer-managed.`,
        `Defaults: core tools, private chats closed, writes disabled.`,
        `Client: ${result.client}; configuration: ${result.client_configuration}.`,
        `Next action: ${result.next_action}${result.error_code ? ` (${result.error_code})` : ''}.`,
        'No installation or configuration was changed. The macOS profile is provisional.',
      ].join('\n'));
      return result.phase === 'failed' ? 1 : 0;
    }
    throw new SetupError('invalid_request');
  } catch (err) {
    // parseArgs, filesystem and adapter messages may contain secret-bearing caller inputs.
    const code = err instanceof SetupError ? safeError(err) : 'invalid_request';
    io.err(JSON.stringify({ format_version: 1, error_code: code }));
    return 1;
  }
}
