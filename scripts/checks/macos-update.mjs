// Native integration test on a disposable GitHub macOS runner with synthetic signing and Telegram data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const prefix = '/Library/Application Support/TelegramMCPGateway';
const plist = '/Library/LaunchDaemons/io.telegram-mcp-gateway.plist';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.platform !== 'darwin' || process.getuid() === 0 ||
    [prefix, plist, '/opt/telegram-gateway-mcp'].some(existsSync)) throw new Error('A fresh hosted macOS runner is required.');
const oldSha = '5a4c22e3d64c49e347c12cb4054a7f4294eb55a2';
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options });
const output = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'gateway-update-'));
const checkout = resolve('.');
const oldCheckout = join(root, 'previous');
const newSha = output('git', ['rev-parse', 'HEAD']);
const npmCli = realpathSync(output('/usr/bin/which', ['npm']));
const key = join(root, 'fixture.key');
const cert = join(root, 'fixture.pem');
run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '1', '-subj', '/CN=Disposable CI fixture',
  '-keyout', key, '-out', cert], { stdio: 'ignore' });
chmodSync(key, 0o600);
const pin = createHash('sha256').update(new X509Certificate(readFileSync(cert)).raw).digest('hex');

run('git', ['fetch', '--depth=1', 'origin', oldSha]);
run('git', ['worktree', 'add', '--detach', oldCheckout, oldSha]);
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: oldCheckout });
run('npm', ['run', 'build'], { cwd: oldCheckout });
function candidate(source, sha) {
  const app = join(root, 'app-' + sha);
  const bundle = join(root, 'bundle-' + sha);
  run(process.execPath, ['scripts/release/prepare-application.mjs', '--output', app, '--npm-cli', npmCli], { cwd: source });
  run(process.execPath, ['scripts/install/build-bundle.mjs', '--output', bundle, '--application', app, '--node', process.execPath,
    '--node-version', process.versions.node, '--node-license', join(source, 'LICENSE'), '--signing-key', key, '--certificate', cert,
    '--source-sha', sha, '--platform', 'darwin', '--architecture', process.arch, '--fixture-runtime'], { cwd: source });
  const bootstrap = join(root, 'fixture-bootstrap-' + sha + '.sh');
  const original = readFileSync(join(source, 'scripts/install/bootstrap-posix.sh'), 'utf8');
  const fixture = original.replace(/trusted_signer_sha256='[0-9a-f]{64}'/, "trusted_signer_sha256='" + pin + "'");
  assert.notEqual(fixture, original);
  writeFileSync(bootstrap, fixture, { mode: 0o700 });
  return operation => run('sudo', ['-n', '/bin/sh', '-c',
    operation === 'update' ? 'umask 077; exec /bin/sh "$@"' : 'umask 022; exec /bin/sh "$@"',
    'bootstrap', bootstrap, bundle, sha, operation]);
}
const previous = candidate(oldCheckout, oldSha);
const next = candidate(checkout, newSha);
previous('install');
const state = join(prefix, 'state');
const token = 'synthetic-test-profile-token-00000000';
const profile = join(root, 'fixture-mcp.json');
writeFileSync(profile, JSON.stringify({ url: 'http://127.0.0.1:7777/mcp', headers: { Authorization: 'Bearer ' + token } }), { mode: 0o600 });
const originalProfile = readFileSync(profile);
const fixtureData = `
  import assert from 'node:assert/strict';
  import { writeFileSync } from 'node:fs';
  import { openStorage } from './dist/storage/sqlite.js';
  import { seal, sha256Hex, unseal } from './dist/core/crypto.js';
  import { loadSessionSecret } from './dist/core/config.js';
  const state = process.argv[1], token = process.argv[2];
  process.umask(0o077);
  const secret = loadSessionSecret(state, {});
  const db = openStorage(state + '/gateway.sqlite');
  if (process.argv[3] === 'seed') {
    writeFileSync(state + '/.env', 'TG_API_ID=1\\nTG_API_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n', { flag: 'wx', mode: 0o600 });
    db.accounts.upsert({id:'fixture', status:'active', tgUserId:'123'});
    db.users.create({id:'reader', tokenSha256:sha256Hex(token), defaultAccount:'fixture'});
    db.accounts.grant('fixture','reader');
    db.sessions.put('fixture', seal('synthetic offline session', secret));
  }
  assert.equal(unseal(db.sessions.get('fixture'), secret), 'synthetic offline session');
  assert.equal(db.users.findByTokenHash(sha256Hex(token)).defaultAccount, 'fixture');
  assert.equal(db.accounts.hasAccess('reader','fixture'), true);
  db.close();
`;
function stateCheck(sha, mode) {
  const release = join(prefix, 'releases', sha);
  run('sudo', ['-n', '-u', '_tgmcp', join(release, 'node'), '--input-type=module', '-e', fixtureData, state, token, mode],
    { cwd: join(release, 'application') });
}
async function status() {
  assert.deepEqual(readFileSync(profile), originalProfile);
  const { url, headers } = JSON.parse(originalProfile);
  for (let attempt = 0; attempt < 25; attempt++) {
    const client = new Client({ name: 'update-fixture', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      const reply = await client.callTool({ name: 'tg_status', arguments: {} });
      assert.ok(!reply.isError && reply.content.some(item => item.type === 'text' && item.text.includes('session active')));
      return;
    } catch (err) { if (attempt === 24) throw err; }
    finally { await client.close(); }
    await sleep(400);
  }
}
stateCheck(oldSha, 'seed');
const label = 'system/io.telegram-mcp-gateway';
run('sudo', ['-n', '/bin/launchctl', 'enable', label]);
run('sudo', ['-n', '/bin/launchctl', 'bootstrap', 'system', plist]);
run('sudo', ['-n', '/bin/launchctl', 'kickstart', label]);
await status();
next('update');
await status();
assert.ok(readFileSync(plist, 'utf8').includes(newSha));
stateCheck(newSha, 'check');
next('update');
await status();
console.log('Managed update verified on launchd with the existing fixture session, credential and MCP endpoint.');
