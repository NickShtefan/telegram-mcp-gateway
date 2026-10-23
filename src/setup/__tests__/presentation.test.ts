import { describe,it,expect } from 'vitest';
import { ownerLabels,ownerClients,nextSteps,apiInstructions,labelRule,clientRule,elevationNotice,sudoPrompt,questionGuidance,answerOwnerPrompt,ownerCommand } from '../presentation.js';
import { installLayout } from '../../install/platform.js';
import type { CliIo } from '../../cli/io.js';

function scripted(answers: string[]): { io: CliIo; lines: string[]; asked: Array<{ question: string; hidden: boolean }> } {
  const lines: string[] = []; const asked: Array<{ question: string; hidden: boolean }> = [];
  return { lines, asked, io: { err: line => lines.push(line), out: () => {}, prompt: async (question, options) => {
    asked.push({ question, hidden: !!options?.hidden }); const answer = answers.shift(); if (answer === undefined) throw new Error('unexpected prompt'); return answer;
  } } };
}
describe('owner wizard presentation',()=>{
 it('explains labels, accepts Enter defaults and preserves chosen labels',async()=>{const text:string[]=[];const answers=['',''];const io={err:(s:string)=>text.push(s),out:()=>{},prompt:async()=>answers.shift()!};expect(await ownerLabels(io)).toEqual({account:'personal',user:'owner'});expect(text.join(' ')).toContain('not its Telegram username');answers.push('test-arm','owner-arm');expect(await ownerLabels(io)).toEqual({account:'test-arm',user:'owner-arm'})});
 it('distinguishes SDK verification, actual model tools and incomplete setup',()=>{const lines:string[]=[];const io={err:(s:string)=>lines.push(s),out:()=>{},prompt:async()=>''};nextSteps(io,['codex','claude'],true,'"/x/tg-mcp-owner" setup');expect(lines.join('\n')).toContain('Close and reopen Codex Desktop/CLI, Claude Code');expect(lines.join('\n')).toContain('telegram_gateway');lines.length=0;nextSteps(io,[],false,'"/x/tg-mcp-owner" setup');expect(lines.join('\n')).not.toContain('Setup complete');expect(apiInstructions.join('\n')).toContain('API development tools')});
 it('explains an invalid label in one line and asks again before building the plan',async()=>{
  const { io, lines, asked } = scripted(['Personal', 'my account', 'work_1', 'x'.repeat(33), '-owner', '']);
  expect(await ownerLabels(io)).toEqual({ account: 'work_1', user: 'owner' });
  expect(lines.filter(line => line === labelRule)).toHaveLength(4);
  expect(asked.map(entry => entry.question)).toEqual([...Array(3).fill('Gateway account id [personal]: '), ...Array(3).fill('Gateway user id [owner]: ')]);
 });
 it('stops after a bounded number of invalid labels without a plan',async()=>{
  const { io, lines } = scripted(['Bad', 'Bad', 'Bad', 'unused']);
  await expect(ownerLabels(io)).rejects.toThrow('invalid_request');
  expect(lines.filter(line => line === labelRule)).toHaveLength(3);
  expect(lines.at(-1)).toBe('Too many invalid answers. Nothing was changed.');
 });
 it('accepts known client names in any case or separator and re-asks for unknown ones',async()=>{
  expect(await ownerClients(scripted(['']).io)).toEqual([]);
  expect(await ownerClients(scripted(['Claude, codex,codex']).io)).toEqual(['claude', 'codex']);
  const retry = scripted(['cursor', 'claude,', 'opencode hermes']);
  expect(await ownerClients(retry.io)).toEqual(['claude']);
  const twice = scripted(['cursor', 'claude code', 'opencode hermes']);
  expect(await ownerClients(twice.io)).toEqual(['opencode', 'hermes']);
  expect(twice.lines).toEqual([clientRule, clientRule]);
  await expect(ownerClients(scripted(['x', 'y', 'z']).io)).rejects.toThrow('invalid_request');
 });
 it('announces the administrator password step without any Telegram application guidance',()=>{
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
   const text = elevationNotice(platform).join('\n');
   expect(text).toContain("your computer's administrator password");
   expect(text).toContain('Telegram details are requested only after this step');
   for (const line of apiInstructions) expect(text).not.toContain(line);
  }
  expect(elevationNotice('win32').join(' ')).toContain('User Account Control');
  expect(elevationNotice('linux').join(' ')).toContain('sudo');
  expect(sudoPrompt).toBe("Your computer's administrator password (sudo): ");
 });
 it('shows API application guidance only right before the hidden application id question',async()=>{
  expect(questionGuidance('api_id')).toEqual(apiInstructions);
  for (const question of ['api_hash', 'phone', 'code', 'password'] as const) expect(questionGuidance(question)).toEqual([]);
  const first = scripted(['12345']); const signal = new AbortController().signal;
  expect(await answerOwnerPrompt(first.io, 'api_id', signal)).toBe('12345');
  expect(first.lines).toEqual(apiInstructions);
  expect(first.asked).toEqual([{ question: 'Telegram application id: ', hidden: true }]);
  const later = scripted(['private-example']);
  await answerOwnerPrompt(later.io, 'api_hash', signal);
  expect(later.lines).toEqual([]);
  expect(later.asked).toEqual([{ question: 'Telegram application hash: ', hidden: true }]);
 });
 it('prints the exact installed owner command for each platform',()=>{
  const sha = 'a'.repeat(40);
  expect(ownerCommand(installLayout('darwin', sha))).toBe('"/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner" setup');
  expect(ownerCommand(installLayout('linux', sha))).toBe('"/opt/telegram-mcp-gateway/bin/tg-mcp-owner" setup');
  expect(ownerCommand(installLayout('win32', sha))).toBe('C:\\ProgramData\\TelegramMCPGateway\\bin\\tg-mcp-owner.cmd setup');
  const { io, lines } = scripted([]);
  nextSteps(io, [], false, ownerCommand(installLayout('win32', sha)));
  expect(lines).toEqual(['No client connection was verified; existing state is kept. To connect a client, run this in an ordinary terminal and select one:',
   'C:\\ProgramData\\TelegramMCPGateway\\bin\\tg-mcp-owner.cmd setup']);
 });
});
