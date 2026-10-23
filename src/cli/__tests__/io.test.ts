import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const ioPath = fileURLToPath(new URL('../../../dist/cli/io.js', import.meta.url));
async function promptProcess(mode: 'eof' | 'abort' | 'answer'): Promise<{ code: unknown; output: string }> {
  const script = `import { terminalIo } from ${JSON.stringify(pathToFileURL(ioPath).href)};
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    const life=new AbortController();
    if (${JSON.stringify(mode)} === 'abort') setTimeout(()=>life.abort(),25);
    terminalIo.prompt('Private input: ', {hidden:true,signal:life.signal})
      .then(answer=>process.stdout.write(answer==='  synthetic-hidden-answer  '?'answered-exact':'answered')).catch(()=>process.stdout.write('cancelled'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exited = once(child, 'close');
  if (mode === 'eof') child.stdin.end();
  if (mode === 'answer') child.stdin.end('  synthetic-hidden-answer  \n');
  try { const [code] = await exited; return { code, output }; }
  finally { child.kill('SIGKILL'); }
}
describe('cancelable human terminal input', () => {
  it('settles on EOF instead of leaving the coordinator waiting', async () => {
    const result = await promptProcess('eof'); expect(result.code).toBe(0); expect(result.output).toContain('cancelled');
  });
  it('closes the input operation when worker lifetime aborts it', async () => {
    const result = await promptProcess('abort'); expect(result.code).toBe(0); expect(result.output).toContain('cancelled');
  });
  it('does not echo synthetic answers while still completing the prompt', async () => {
    const result = await promptProcess('answer'); expect(result.code).toBe(0); expect(result.output).toContain('answered-exact');
    expect(result.output).not.toContain('synthetic-hidden-answer');
  });
});
