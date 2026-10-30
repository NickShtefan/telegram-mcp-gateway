import { describe,it,expect } from 'vitest';
import { ownerReady,ownerInterface,ownerLabels,ownerClients,nextSteps,apiInstructions,labelRule,clientRule,elevationNotice,sudoPrompt,questionGuidance,answerOwnerPrompt,ownerCommand,suggestedInterface,configureAfterInstall,ownerLoginMethod } from '../presentation.js';
import { installLayout } from '../../install/platform.js';
import type { CliIo } from '../../cli/io.js';

function scripted(answers: string[]): { io: CliIo; lines: string[]; asked: Array<{ question: string; hidden: boolean }> } {
  const lines: string[] = []; const asked: Array<{ question: string; hidden: boolean }> = [];
  return { lines, asked, io: { err: line => lines.push(line), out: () => {}, prompt: async (question, options) => {
    asked.push({ question, hidden: !!options?.hidden }); const answer = answers.shift(); if (answer === undefined) throw new Error('unexpected prompt'); return answer;
  } } };
}
describe('owner wizard presentation',()=>{
 it('shows a concise capture warning without asking for a magic phrase',async()=>{
  const { io, lines, asked } = scripted([]); await ownerReady(io);
  expect(asked).toEqual([]); expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('Same-user software'); expect(lines[0]).toContain('hidden prompts do not prevent capture');
 });
 it('uses local desktop or SSH defaults while accepting explicit numeric overrides',async()=>{
  expect(suggestedInterface({},'darwin')).toBe('browser');
  for(const env of [{SSH_CONNECTION:'fixture'}, {SSH_TTY:'/dev/fixture'}, {SSH_CLIENT:'fixture'}]){
   expect(suggestedInterface(env,'darwin')).toBe('console');
   expect(await ownerInterface(scripted(['']).io,env,'darwin')).toBe('console');
   expect(await ownerInterface(scripted(['1']).io,env,'darwin')).toBe('browser');
  }
  expect(suggestedInterface({},'linux')).toBe('console');
  expect(suggestedInterface({DISPLAY:':0'},'linux')).toBe('browser');
  expect(await ownerInterface(scripted(['2']).io,{},'darwin')).toBe('console');
 });
 it('offers configure later without collecting labels or secrets',async()=>{
  const later=scripted(['2']);expect(await configureAfterInstall(later.io)).toBe(false);expect(later.asked).toHaveLength(1);
  const normal=scripted([]);expect(await ownerLabels(normal.io)).toEqual({account:'personal',user:'owner'});expect(normal.asked).toEqual([]);
 });
 it('lets the owner choose a complete console path or the default browser guide',async()=>{
  expect(await ownerInterface(scripted(['']).io,{},'darwin')).toBe('browser');
  expect(await ownerInterface(scripted(['CONSOLE']).io)).toBe('console');
  expect(await ownerInterface(scripted(['unknown','console']).io)).toBe('console');
 });
 it('explains labels, accepts Enter defaults and preserves chosen labels',async()=>{const text:string[]=[];const answers=['',''];const io={err:(s:string)=>text.push(s),out:()=>{},prompt:async()=>answers.shift()!};expect(await ownerLabels(io,true)).toEqual({account:'personal',user:'owner'});expect(text.join(' ')).toContain('not its Telegram username');answers.push('test-arm','owner-arm');expect(await ownerLabels(io,true)).toEqual({account:'test-arm',user:'owner-arm'})});
 it('distinguishes SDK verification, actual model tools and incomplete setup',()=>{const lines:string[]=[];const io={err:(s:string)=>lines.push(s),out:()=>{},prompt:async()=>''};nextSteps(io,['codex','claude'],true,'"/x/tg-mcp-owner" setup');expect(lines.join('\n')).toContain('NEXT: RESTART Codex Desktop/CLI, Claude Code');expect(lines.join('\n')).toContain('telegram_gateway');lines.length=0;nextSteps(io,[],false,'"/x/tg-mcp-owner" setup');expect(lines.join('\n')).not.toContain('Setup complete');expect(apiInstructions.join('\n')).toContain('API development tools')});
 it('explains an invalid label in one line and asks again before building the plan',async()=>{
  const { io, lines, asked } = scripted(['Personal', 'my account', 'work_1', 'x'.repeat(33), '-owner', '']);
  expect(await ownerLabels(io,true)).toEqual({ account: 'work_1', user: 'owner' });
  expect(lines.filter(line => line === labelRule)).toHaveLength(4);
  expect(asked.map(entry => entry.question)).toEqual([...Array(3).fill('Gateway account id [personal]: '), ...Array(3).fill('Gateway user id [owner]: ')]);
 });
 it('stops after a bounded number of invalid labels without a plan',async()=>{
  const { io, lines } = scripted(['Bad', 'Bad', 'Bad', 'unused']);
  await expect(ownerLabels(io,true)).rejects.toThrow('invalid_request');
  expect(lines.filter(line => line === labelRule)).toHaveLength(3);
  expect(lines.at(-1)).toBe('Too many invalid answers. Nothing was changed.');
 });
 it('accepts known client names in any case or separator and re-asks for unknown ones',async()=>{
  expect(await ownerClients(scripted(['']).io)).toEqual([]);
  expect(await ownerClients(scripted(['Claude, codex,codex']).io)).toEqual(['claude', 'codex']);
  const retry = scripted(['unknown', 'claude,', 'opencode hermes']);
  expect(await ownerClients(retry.io)).toEqual(['claude']);
  const twice = scripted(['unknown', 'claude code', 'opencode hermes']);
  expect(await ownerClients(twice.io)).toEqual(['opencode', 'hermes']);
  expect(twice.lines.filter(line=>line===clientRule)).toEqual([clientRule, clientRule]);
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
 it('clearly frames API action steps and uses visible ID/phone, revealable hash and hidden code/2FA',async()=>{
  expect(questionGuidance('api_id')).toEqual(apiInstructions);
  for (const question of ['api_hash', 'phone', 'code', 'password'] as const) expect(questionGuidance(question)).toEqual([]);
  const first = scripted(['12345']); const signal = new AbortController().signal;
  expect(await answerOwnerPrompt(first.io, 'api_id', signal)).toBe('12345');
  expect(first.lines.slice(0, apiInstructions.length)).toEqual(apiInstructions);
  expect(first.lines.join('\n')).toContain('YOUR ACTION REQUIRED');
  expect(first.lines.join('\n')).toContain('1. Open https://my.telegram.org/apps');
  expect(first.lines.join('\n')).toContain('2. Choose API development tools');
  expect(first.lines.join('\n')).toContain('3. Copy api_id and api_hash');
  expect(first.asked).toEqual([{ question: 'Telegram application id: ', hidden: false }]);
  const later = scripted(['private-example']);
  await answerOwnerPrompt(later.io, 'api_hash', signal);
  expect(later.lines).toEqual([]);
  expect(later.asked).toEqual([{ question: 'Telegram application hash: ', hidden: true }]);
  for(const [question,hidden] of [['phone',false],['code',true],['password',true]] as const){const f=scripted(['value']);await answerOwnerPrompt(f.io,question,signal);expect(f.asked[0].hidden).toBe(hidden);}
  let received:unknown;await answerOwnerPrompt({out:()=>undefined,err:()=>undefined,prompt:async(_question,options)=>{received=options;return 'fixture';}},'api_hash',signal);
  expect(received).toMatchObject({hidden:true,reveal:true,signal});
 });
 it('keeps action guidance plain without styling support and honors numeric/text login choices',async()=>{
  const plain=scripted(['12345']);await answerOwnerPrompt(plain.io,'api_id',new AbortController().signal);expect(plain.lines.join('')).not.toContain('\u001b[');
  const styled=scripted(['12345']);styled.io.interactive=true;styled.io.ansi=true;await answerOwnerPrompt(styled.io,'api_id',new AbortController().signal);expect(styled.lines.join('')).toContain('\u001b[1;36mYOUR ACTION REQUIRED');
  for(const [answer,method] of [['','qr'],['1','qr'],['QR','qr'],['2','phone'],['PHONE','phone']])expect(await ownerLoginMethod(scripted([answer]).io,new AbortController().signal)).toBe(method);
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
