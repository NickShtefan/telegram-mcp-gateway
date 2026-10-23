/** Human-only text. Never include tokens, credentials or profile contents. */
import { posix, win32 } from 'node:path';
import type { CliIo } from '../cli/io.js';
import type { ClientKind } from './clientConfig.js';
import type { InstallLayout } from '../install/platform.js';
import { ownerLabelPattern } from './owner.js';
import { questions } from './promptChannel.js';
import { SetupError } from './contract.js';

/** Invalid choices are explained and asked again a bounded number of times, before anything is changed. */
const attempts = 3;
async function askValid<T>(io: CliIo, question: string, rule: string, accept: (answer: string) => T | null): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = accept((await io.prompt(question)).trim());
    if (value !== null) return value;
    io.err(rule);
  }
  io.err('Too many invalid answers. Nothing was changed.');
  throw new SetupError('invalid_request');
}
export const labelRule = 'Use 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.';
const label = (value: string): string | null => ownerLabelPattern.test(value) ? value : null;
export async function ownerLabels(io:CliIo):Promise<{account:string;user:string}> {
  io.err('Account id is a local label for this Telegram account, not its Telegram username. Press Enter for personal.');
  const account=await askValid(io,'Gateway account id [personal]: ',labelRule,answer=>label(answer||'personal'));
  io.err('User id names this gateway permission profile, not your OS login. Press Enter for owner.');
  const user=await askValid(io,'Gateway user id [owner]: ',labelRule,answer=>label(answer||'owner'));return {account,user};
}
const clientNames: readonly string[] = ['codex', 'claude', 'opencode', 'hermes'];
export const clientRule = 'Use only codex, claude, opencode or hermes, separated by commas, or press Enter to skip.';
export async function ownerClients(io: CliIo): Promise<ClientKind[]> {
  return askValid(io, 'Clients (codex,claude,opencode,hermes; comma-separated; empty to skip): ', clientRule, answer => {
    const names = answer.toLowerCase().split(/[\s,]+/).filter(Boolean);
    return names.every(name => clientNames.includes(name)) ? [...new Set(names)] as ClientKind[] : null;
  });
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
  return io.prompt(questions[question], { hidden: true, signal });
}
/** The exact installed owner command, ready to paste into an ordinary terminal. */
export function ownerCommand(layout: Pick<InstallLayout, 'platform' | 'prefix'>): string {
  return layout.platform === 'win32' ? `${win32.join(layout.prefix, 'bin', 'tg-mcp-owner.cmd')} setup` : `"${posix.join(layout.prefix, 'bin', 'tg-mcp-owner')}" setup`;
}
export function nextSteps(io:CliIo,clients:ClientKind[],verified:boolean,rerunCommand:string):void {
  if(!verified){io.err('No client connection was verified; existing state is kept. To connect a client, run this in an ordinary terminal and select one:');io.err(rerunCommand);return;}
  const labels={codex:'Codex Desktop/CLI',claude:'Claude Code',opencode:'OpenCode',hermes:'Hermes'};
  io.err('Setup complete: the service and authenticated MCP connection were verified.');
  io.err(`Close and reopen ${clients.map(c=>labels[c]).join(', ')}; start a fresh conversation.`);
  io.err('Ask: Use the telegram_gateway MCP server to call tg_status. An actual tool call confirms model tool loading.');
  io.err('Private chats and writes remain disabled by default. No token needs to be copied.');
}
