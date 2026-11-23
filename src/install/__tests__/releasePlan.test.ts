import { it,expect } from 'vitest';import { resolve } from 'node:path';import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const {requireRun,manifestEvidence,draftArguments}=await import(pathToFileURL(resolve('scripts/release/plan.mjs')).href);
it('rejects another source, failed CI and ambiguous manifest evidence',()=>{const sha='a'.repeat(40),ci={head_sha:sha,status:'completed',conclusion:'success',path:'.github/workflows/platform-checks.yml'};expect(()=>requireRun(ci,sha)).not.toThrow();expect(()=>requireRun(ci,'b'.repeat(40))).toThrow();expect(()=>requireRun({...ci,conclusion:'failure'},sha)).toThrow();const evidence=JSON.stringify({format_version:1,phase:'unsigned_candidate_created',source_sha:sha,manifest_sha256:'c'.repeat(64)});expect(manifestEvidence('timestamp '+evidence,sha)).toBe('c'.repeat(64));expect(()=>manifestEvidence(evidence+'\n'+evidence,sha)).toThrow();expect(()=>manifestEvidence(evidence,'b'.repeat(40))).toThrow()});
it('creates only a draft against the frozen commit with all eight public assets',()=>{const args=draftArguments({tag:'v0.3.0',repo:'NickShtefan/telegram-mcp-gateway',sha:'a'.repeat(40),notes:'notes.md',assets:Array.from({length:8},(_,i)=>'asset'+i)});expect(args).toContain('--draft');expect(args[args.indexOf('--target')+1]).toBe('a'.repeat(40));expect(()=>draftArguments({tag:'--publish',repo:'x/y',sha:'a'.repeat(40),notes:'n',assets:[]})).toThrow()});

it('cannot create an older release from the current draft workflow', () => {
  const request = { repo: 'NickShtefan/telegram-mcp-gateway', sha: 'a'.repeat(40), notes: 'notes.md',
    assets: Array.from({ length: 8 }, (_, i) => 'asset' + i) };
  expect(() => draftArguments({ ...request, tag: 'v0.2.0' })).toThrow('draft_plan_invalid');
});

it('loads the release plan from source with no build output', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'tg-release-plan-'));
  try {
    mkdirSync(join(checkout, 'scripts', 'release'), { recursive: true });
    for (const file of ['package.json', 'scripts/release/plan.mjs']) copyFileSync(file, join(checkout, file));
    const url = pathToFileURL(join(checkout, 'scripts/release/plan.mjs')).href;
    const tag = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { RELEASE_TAG } from ${JSON.stringify(url)}; process.stdout.write(RELEASE_TAG);`,
    ], { cwd: checkout, encoding: 'utf8', timeout: 10000 });
    expect(tag).toBe(`v${JSON.parse(readFileSync('package.json', 'utf8')).version}`);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
