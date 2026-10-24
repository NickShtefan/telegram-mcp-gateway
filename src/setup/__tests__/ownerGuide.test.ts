import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { startOwnerGuide, browserOwnerLogin, type OwnerGuide } from '../ownerGuide.js';
import type { OwnerQuestion } from '../promptChannel.js';

const guides: OwnerGuide[] = [];
afterEach(async () => { for (const guide of guides.splice(0)) await guide.close(); });
async function fixture(timeoutMs?: number) {
  const guide = await startOwnerGuide(timeoutMs); guides.push(guide);
  const url = new URL(guide.url); const origin = url.origin;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Setup-Token': url.hash.slice(1) };
  const state = async () => (await fetch(origin + '/api/status', { headers })).json() as Promise<Record<string, unknown>>;
  const answer = (sequence: number, value: string) => fetch(origin + '/api/answer', { method: 'POST', headers, body: JSON.stringify({ sequence, value }) });
  return { guide, origin, headers, state, answer };
}

describe('temporary owner guide boundary', () => {
  it('serves the guide without credentials and requires the private capability, correct Host and same Origin for API access', async () => {
    const f = await fixture();
    const page = await fetch(f.origin); const html = await page.text();
    expect(page.status).toBe(200); expect(html).toContain('Create your Telegram app');
    expect(html).not.toContain(f.headers['X-Setup-Token']);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(f.origin + '/api/status')).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, 'X-Setup-Token': '0'.repeat(64) } })).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, 'X-Setup-Token': 'é'.repeat(64) } })).status).toBe(403);
    expect((await fetch(f.origin + '/api/status', { headers: { ...f.headers, Origin: 'https://example.invalid' } })).status).toBe(403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      request(f.origin, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    expect(rebound).toBe(403);
    expect((await fetch(f.origin + '/api/answer', { method: 'OPTIONS', headers: f.headers })).status).toBe(403);
  });
  it('accepts each pending answer once, validates values and never returns submitted secrets', async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const pending = f.guide.answer('api_hash', signal); const state = await f.state();
    expect((await f.answer(Number(state.sequence), 'bad')).status).toBe(400);
    expect((await f.answer(Number(state.sequence) + 1, 'a'.repeat(32))).status).toBe(409);
    expect((await f.answer(Number(state.sequence), 'a'.repeat(32))).status).toBe(200);
    expect(await pending).toBe('a'.repeat(32));
    expect((await f.answer(Number(state.sequence), 'a'.repeat(32))).status).toBe(409);
    expect(JSON.stringify(await f.state())).not.toContain('a'.repeat(32));
    for (const [question, value] of [['api_id', '12345'], ['login_method', 'phone'], ['phone', '+15551234567'], ['code', '12345'], ['password', ' fixture password ']] as Array<[OwnerQuestion, string]>) {
      const input = f.guide.answer(question, signal);
      expect((await f.answer(Number((await f.state()).sequence), value)).status).toBe(200);
      expect(await input).toBe(value);
    }
  });
  it('renders refreshed QR tokens only on the private endpoint and clears them at the next prompt and completion', async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const method = f.guide.answer('login_method', signal);
    await f.answer(Number((await f.state()).sequence), 'qr'); await method;
    f.guide.qr({ token: Buffer.from('synthetic QR token one').toString('base64url'), expires: 2000000000 });
    const first = await f.state(); expect(first.phase).toBe('qr'); expect(first.qrImage).toMatch(/^data:image\/svg\+xml;base64,/);
    f.guide.qr({ token: Buffer.from('synthetic QR token two').toString('base64url'), expires: 2000000030 });
    const second = await f.state(); expect(second.qrImage).not.toBe(first.qrImage);
    const password = f.guide.answer('password', signal);
    expect((await f.state()).qrImage).toBeUndefined();
    await f.answer(Number((await f.state()).sequence), 'test-password'); await password;
    f.guide.finish(true); f.guide.finish(false);
    expect(await f.state()).toMatchObject({ phase: 'complete' });
  });
  it('rejects unexpected JSON, oversized input and cross-origin cancellation while preserving the pending question', async () => {
    const f = await fixture(); const pending = f.guide.answer('api_id', new AbortController().signal);
    const sequence = Number((await f.state()).sequence);
    expect((await fetch(f.origin + '/api/answer', { method: 'POST', headers: f.headers, body: JSON.stringify({ sequence, value: '12345', extra: true }) })).status).toBe(400);
    expect((await f.answer(sequence, 'x'.repeat(2200))).status).toBe(400);
    expect((await fetch(f.origin + '/api/cancel', { method: 'POST', headers: { ...f.headers, Origin: 'https://example.invalid' }, body: '{}' })).status).toBe(403);
    expect(f.guide.signal.aborted).toBe(false);
    await f.answer(sequence, '12345'); expect(await pending).toBe('12345');
  });
  it('cancels and expires pending input, and closes the listener', async () => {
    const f = await fixture(); const pending = f.guide.answer('code', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('invalid_state');
    await fetch(f.origin + '/api/cancel', { method: 'POST', headers: f.headers, body: '{}' });
    await rejected; expect(f.guide.signal.aborted).toBe(true); await f.guide.close();
    await expect(fetch(f.origin)).rejects.toThrow();
    const expires = await fixture(20); const input = expires.guide.answer('code', new AbortController().signal);
    await expect(input).rejects.toThrow('invalid_state'); expect(expires.guide.signal.aborted).toBe(true);
  });
  it('starts no listener until input is requested and falls back to console if browser launch fails', async () => {
    const opened = vi.fn(async () => { throw new Error('synthetic browser failure'); });
    const io = { out: vi.fn(), err: vi.fn(), prompt: vi.fn(async () => '12345') };
    const ui = browserOwnerLogin(io, opened);
    expect(opened).not.toHaveBeenCalled();
    expect(await ui.answer('api_id', new AbortController().signal)).toBe('12345');
    expect(await ui.answer('login_method', new AbortController().signal)).toBe('phone');
    expect(opened).toHaveBeenCalledTimes(1); expect(ui.signal.aborted).toBe(false);
    expect(JSON.stringify(io.err.mock.calls)).not.toContain('#'); await ui.close();
  });
});
