import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ownerGuidePage } from '../ownerGuidePage.js';

interface Element {
  value: string; hidden: boolean; textContent: string; src: string; type: string;
  onclick?: () => Promise<void>; onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  setAttribute(name: string, value: string): void; removeAttribute(name: string): void;
  focus(): void; replaceChildren(...children: Element[]): void; classList: { toggle(): void };
}
interface State { phase: string; sequence: number; question?: string; qrImage?: string; expires?: number; }

/** Run the actual generated page script with a minimal DOM and synthetic HTTP, no browser dependency. */
function pageFixture() {
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    let node = elements.get(id);
    if (!node) {
      node = { value: '', hidden: true, textContent: '', src: '', type: 'text',
        setAttribute() {}, removeAttribute(name) { if (name === 'src') this.src = ''; }, focus() {}, replaceChildren() {}, classList: { toggle() {} } };
      elements.set(id, node);
    }
    return node;
  };
  let state: State = { phase: 'qr', sequence: 1, qrImage: 'data:image/svg+xml;base64,fixture', expires: 2000000000 };
  const answers: Array<{ sequence: number; value: string }> = [];
  const timers: Array<() => void> = []; let delayStatus = false; let releaseStatus: (() => void) | undefined; let rejectStatus: (() => void) | undefined;
  const context = {
    location: { hash: '#' + 'a'.repeat(64), pathname: '/' }, history: { replaceState() {} },
    document: { getElementById: element, querySelector: element,
      querySelectorAll: (selector: string) => selector === '.steps li' ? [element('step1'), element('step2'), element('step3')]
        : selector === '[data-cancel]' ? [element('cancel')]
          : selector === 'button[type=submit]' ? [element('submit')]
            : selector === 'input' ? ['phone', 'secret', 'api-id', 'api-hash'].map(element) : [],
      createElement: () => element('new-item') },
    setTimeout: (callback: () => void) => { timers.push(callback); },
    fetch: async (path: string, options: { body?: string }) => {
      const value = options.body ? JSON.parse(options.body) as { method?: string; sequence: number; value: string } : null;
      if (path === '/api/method') state = value?.method === 'qr'
        ? { phase: 'qr', sequence: state.sequence + 1, qrImage: 'data:image/svg+xml;base64,next', expires: 2000000000 }
        : { phase: 'prompt', question: 'phone', sequence: state.sequence + 1 };
      if (path === '/api/answer') {
        answers.push({ sequence: value!.sequence, value: value!.value });
        state = { phase: 'prompt', question: 'code', sequence: state.sequence + 1 };
      }
      const snapshot = { ...state };
      if (path === '/api/status' && delayStatus) {
        delayStatus = false; await new Promise<void>((resolve, reject) => { releaseStatus = resolve; rejectStatus = () => reject(new Error('cancelled stale request')); });
      }
      return { ok: true, json: async () => path === '/api/status' ? snapshot : { ok: true } };
    },
  };
  const source = ownerGuidePage('fixture-nonce').match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(source, context);
  const flush = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)); };
  const poll = async (): Promise<void> => { const next = timers.shift(); expect(next).toBeDefined(); next!(); await flush(); };
  return { element, answers, flush, poll, delayNextStatus: () => { delayStatus = true; }, releaseStatus: () => releaseStatus?.(), rejectStatus: () => rejectStatus?.() };
}

describe('generated owner guide authentication state', () => {
  it('requires fresh phone entry after phone/code -> QR -> phone and clears login secrets', async () => {
    const f = pageFixture(); await f.flush();
    await f.element('tab-phone').onclick!(); await f.poll();
    f.element('phone').value = '+15551234567';
    await f.element('phone-choice').onsubmit!({ preventDefault() {} }); await f.poll();
    expect(f.answers.map(answer => answer.value)).toEqual(['+15551234567']);
    f.element('secret').value = '12345';
    await f.element('tab-qr').onclick!(); await f.poll();
    expect(f.element('secret').value).toBe(''); expect(f.element('phone').value).toBe('');
    await f.element('tab-phone').onclick!(); await f.poll(); await f.poll();
    expect(f.answers.map(answer => answer.value)).toEqual(['+15551234567']);
    expect(f.element('phone-choice').hidden).toBe(false); expect(f.element('phone').value).toBe('');
    f.element('phone').value = '+15557654321';
    await f.element('phone-choice').onsubmit!({ preventDefault() {} });
    expect(f.answers.map(answer => answer.value)).toEqual(['+15551234567', '+15557654321']);
  });

  it('ignores an old status response after method cancellation instead of restoring its phone/code fields', async () => {
    const f = pageFixture(); await f.flush();
    await f.element('tab-phone').onclick!(); await f.poll();
    f.element('phone').value = '+15551234567';
    f.delayNextStatus(); await f.poll();
    await f.element('tab-qr').onclick!(); f.releaseStatus(); await f.flush(); await f.poll();
    expect(f.element('phone').value).toBe(''); expect(f.element('phone-choice').hidden).toBe(true);
    expect(f.answers).toEqual([]);
    f.delayNextStatus(); await f.poll();
    await f.element('cancel').onclick!(); f.rejectStatus(); await f.flush();
    expect(f.element('result-title').textContent).toBe('Setup cancelled'); expect(f.element('signin').hidden).toBe(true);
  });
});
