/** Human-only text. Never include tokens, credentials or profile contents. */
import { posix, win32 } from 'node:path';
import type { CliIo } from '../cli/io.js';
import type { ClientKind } from './clientConfig.js';
import type { InstallLayout } from '../install/platform.js';
import { ownerLabelPattern } from './owner.js';
import { questions } from './promptChannel.js';
import { SetupError } from './contract.js';
import { CLIENT_KINDS, CLIENT_LABELS, CLIENT_RESTART, clientListSchema } from './clientCatalog.js';

/** Invalid choices are explained and asked again a bounded number of times, before anything is changed. */
const attempts = 3;
async function askValid<T>(io: CliIo, question: string, rule: string, accept: (answer: string) => T | null, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = accept((await (signal ? io.prompt(question, { signal }) : io.prompt(question))).trim());
    if (value !== null) return value;
    io.err(rule);
  }
  io.err('Too many invalid answers. Nothing was changed.');
  throw new SetupError('invalid_request');
}
export const labelRule = 'Use 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.';
/** A warning is guidance, not an attestation of capture software or human presence. */
export async function ownerReady(io: CliIo): Promise<void> {
  io.err('Enter Telegram secrets yourself with agents and terminal capture stopped. Same-user software can read this input; hidden prompts do not prevent capture.');
}
const label = (value: string): string | null => ownerLabelPattern.test(value) ? value : null;
export async function ownerLabels(io:CliIo, advanced = false):Promise<{account:string;user:string}> {
  if (!advanced) return { account: 'personal', user: 'owner' };
  io.err('Account id is a local label for this Telegram account, not its Telegram username. Press Enter for personal.');
  const account=await askValid(io,'Gateway account id [personal]: ',labelRule,answer=>label(answer||'personal'));
  io.err('User id names this gateway permission profile, not your OS login. Press Enter for owner.');
  const user=await askValid(io,'Gateway user id [owner]: ',labelRule,answer=>label(answer||'owner'));return {account,user};
}
const clientNames: readonly string[] = CLIENT_KINDS;
export const clientRule = 'Use only codex, claude, cursor, hermes, opencode or openclaw, separated by commas, or press Enter to skip.';
export async function ownerClients(io: CliIo, signal?: AbortSignal): Promise<ClientKind[]> {
  const selected = await io.select?.('Choose the apps to connect (or leave all unchecked to set up later):',
    CLIENT_KINDS.map(value => ({ value, label: CLIENT_LABELS[value] })), { multiple: true, signal });
  if (selected) return clientListSchema.parse(selected);
  io.err(CLIENT_KINDS.map((client, index) => `${index + 1}. ${CLIENT_LABELS[client]}`).join('\n'));
  return askValid(io, 'Clients (codex,claude,cursor,hermes,opencode,openclaw; comma-separated; empty to skip): ', clientRule, answer => {
    const names = answer.toLowerCase().split(/[\s,]+/).filter(Boolean).map(value => /^[1-6]$/.test(value) ? CLIENT_KINDS[Number(value) - 1]! : value);
    return names.every(name => clientNames.includes(name)) ? [...new Set(names)] as ClientKind[] : null;
  }, signal);
}
export function suggestedInterface(env: NodeJS.ProcessEnv = process.env, platform = process.platform): 'browser' | 'console' {
  return env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? 'console' : 'browser';
}
export async function ownerInterface(io: CliIo, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<'browser' | 'console'> {
  const recommended = suggestedInterface(env, platform);
  if (recommended === 'console') io.err('Console is recommended for SSH or a machine without a local desktop. A browser would open on this machine.');
  const selected = await io.select?.('Choose your setup interface:',
    [{ value: 'browser', label: `Browser guide${recommended === 'browser' ? ' (recommended)' : ''}` }, { value: 'console', label: `Console${recommended === 'console' ? ' (recommended)' : ''}` }], { selected: [recommended] });
  if (selected?.length === 1 && (selected[0] === 'browser' || selected[0] === 'console')) return selected[0];
  return askValid(io, `Setup interface: 1. browser guide, 2. console [${recommended}]: `, 'Enter 1/browser or 2/console.', answer => {
    const value = ({ '1': 'browser', '2': 'console' } as Record<string, string>)[answer] ?? (answer.toLowerCase() || recommended);
    return value === 'browser' || value === 'console' ? value : null;
  });
}
export async function configureAfterInstall(io: CliIo): Promise<boolean> {
  io.err('System installation is complete. Next, connect your Telegram account.');
  const choices = [{ value: 'now', label: 'Configure Telegram now (recommended)' }, { value: 'later', label: 'Configure later' }];
  const selected = await io.select?.('Continue setup:', choices, { selected: ['now'] });
  if (selected?.length === 1 && choices.some(choice => choice.value === selected[0])) return selected[0] === 'now';
  return askValid(io, 'Configure Telegram now? 1. now, 2. later [now]: ', 'Enter 1/now or 2/later.', answer =>
    ['', '1', 'now'].includes(answer.toLowerCase()) ? true : ['2', 'later'].includes(answer.toLowerCase()) ? false : null);
}
/** sudo shows this instead of its generic prompt, so the administrator password is not mistaken for a Telegram value. */
export const sudoPrompt = "Your computer's administrator password (sudo): ";
/** Shown immediately before the operating system asks for administrator approval. */
export function elevationNotice(platform: InstallLayout['platform']): string[] {
  return platform === 'win32'
    ? ['Next, Windows asks for administrator approval (User Account Control) to start the protected setup.',
      "Approve it and, if Windows asks, enter your computer's administrator password. Telegram details are requested only after this step."]
    : ["Next, sudo may ask for your computer's administrator password to start the protected setup.",
      "Type your computer's administrator password there, not a Telegram value. Telegram details are requested only after this step."];
}
export const apiInstructions=[
  'Open https://my.telegram.org/apps and sign in with your Telegram phone number.',
  'Choose API development tools and create an application using a descriptive title and short name.',
  'Copy api_id and api_hash into the hidden prompts here. Keep codes/passwords out of chat and screenshots.',
];
/** Fixed guidance for a private question. The elevated worker asks for API credentials only when it needs new ones. */
export function questionGuidance(question: keyof typeof questions): readonly string[] {
  return question === 'api_id' ? apiInstructions : [];
}
export async function answerOwnerPrompt(io: CliIo, question: keyof typeof questions, signal: AbortSignal): Promise<string> {
  for (const line of questionGuidance(question)) io.err(line);
  if (question === 'api_id') io.err('Secret input is hidden: no characters or dots appear while you type. Press Enter to submit each value.');
  return io.prompt(questions[question], { hidden: true, signal });
}
/** The exact installed owner command, ready to paste into an ordinary terminal. */
export function ownerCommand(layout: Pick<InstallLayout, 'platform' | 'prefix'>): string {
  return layout.platform === 'win32' ? `${win32.join(layout.prefix, 'bin', 'tg-mcp-owner.cmd')} setup` : `"${posix.join(layout.prefix, 'bin', 'tg-mcp-owner')}" setup`;
}
export function nextSteps(io:CliIo,clients:ClientKind[],verified:boolean,rerunCommand:string):void {
  if(!verified){io.err('No client connection was verified; existing state is kept. To connect a client, run this in an ordinary terminal and select one:');io.err(rerunCommand);return;}
  io.err('Setup complete: the service and authenticated MCP connection were verified.');
  io.err(`NEXT: RESTART ${clients.map(c=>CLIENT_LABELS[c]).join(', ')} TO LOAD TELEGRAM MCP.`);
  for (const client of clients) io.err(`${CLIENT_LABELS[client]}: ${CLIENT_RESTART[client]}`);
  io.err('Ask: Use the telegram_gateway MCP server to call tg_status. An actual tool call confirms model tool loading.');
  io.err('Private chats and writes remain disabled by default. No token needs to be copied.');
}
