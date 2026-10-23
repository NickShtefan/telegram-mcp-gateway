/** Read-only inspection. No gateway configuration, SQLite or Telegram dependencies. */
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release } from 'node:os';
import { z } from 'zod';
import { clientSchema, parseSafe, safeError, SetupError, type SetupErrorCode, type ClientSelection } from './contract.js';

// Provisional new-installation profile; never reuse the existing lab layout automatically.
export const SETUP_ROOT = '/Library/Application Support/TelegramMCPGateway';
const LEGACY_ROOT = '/opt/telegram-gateway-mcp';

const optionsSchema = z.strictObject({
  port: z.number().int().min(1).max(65535), client: clientSchema,
});
type PreflightOptions = z.infer<typeof optionsSchema>;
export interface PreflightProbe {
  platform: string;
  architecture: string;
  darwinMajor: number;
  installation(): Promise<'absent' | 'present' | 'legacy'>;
  portAvailable(port: number): Promise<boolean>;
  clientConfiguration(client: Exclude<ClientSelection, 'none'>): Promise<'absent' | 'present' | 'not_inspected'>;
}

export interface PreflightResult {
  format_version: 1;
  phase: 'preflight_ready' | 'failed';
  error_code: SetupErrorCode | null;
  next_action: 'review_plan' | 'review_existing_installation' | 'retry_inspection';
  architecture: 'arm64' | 'x64' | null;
  port: number;
  client: ClientSelection;
  client_configuration: 'not_selected' | 'absent' | 'present' | 'not_inspected';
  artifact: 'requires_verified_package';
  runtime: 'installer_managed';
  profile: 'provisional_macos';
  minimum_os: 'macos_13';
  defaults: { toolsets: ['core']; private_chats: 'closed'; writes: 'disabled' };
  owner_actions: ['verify_package', 'approve_system_installation', 'enter_credentials', 'select_access'];
}

export async function preflight(options: PreflightOptions, probe: PreflightProbe = systemProbe): Promise<PreflightResult> {
  const o = parseSafe(optionsSchema, options, 'invalid_request');
  const result: PreflightResult = {
    format_version: 1, phase: 'preflight_ready', error_code: null, next_action: 'review_plan',
    architecture: null, port: o.port, client: o.client,
    client_configuration: o.client === 'none' ? 'not_selected' : 'not_inspected',
    artifact: 'requires_verified_package', runtime: 'installer_managed', profile: 'provisional_macos', minimum_os: 'macos_13',
    defaults: { toolsets: ['core'], private_chats: 'closed', writes: 'disabled' },
    owner_actions: ['verify_package', 'approve_system_installation', 'enter_credentials', 'select_access'],
  };
  try {
    if (probe.platform !== 'darwin') throw new SetupError('unsupported_platform');
    if (!Number.isInteger(probe.darwinMajor) || probe.darwinMajor < 22) throw new SetupError('unsupported_os_version');
    if (probe.architecture !== 'arm64' && probe.architecture !== 'x64') throw new SetupError('unsupported_architecture');
    result.architecture = probe.architecture;
    const installed = await probe.installation();
    if (installed !== 'absent') throw new SetupError('existing_installation_requires_review');
    if (!await probe.portAvailable(o.port)) throw new SetupError('port_unavailable');
    if (o.client !== 'none') {
      const client = await probe.clientConfiguration(o.client);
      if (!['absent', 'present', 'not_inspected'].includes(client)) throw new SetupError('inspection_failed');
      result.client_configuration = client;
    }
  } catch (err) {
    result.phase = 'failed';
    result.error_code = err instanceof SetupError ? safeError(err) : 'inspection_failed';
    result.next_action = result.error_code === 'existing_installation_requires_review' ? 'review_existing_installation' : 'retry_inspection';
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const systemProbe: PreflightProbe = {
  platform: process.platform, architecture: process.arch, darwinMajor: Number(release().split('.')[0]),
  installation: async () => await exists(LEGACY_ROOT) ? 'legacy' : await exists(SETUP_ROOT) ? 'present' : 'absent',
  portAvailable: port => new Promise(resolve => {
    // Probe only loopback reachability, never open a listener or make an HTTP/MCP call.
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (available: boolean): void => { socket.destroy(); resolve(available); };
    socket.once('connect', () => done(false));
    socket.once('error', err => done((err as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
    socket.setTimeout(500, () => done(false));
  }),
  // No client-path/storage contract is assumed before #9.
  clientConfiguration: async () => 'not_inspected',
};
