import { describe, expect, it } from 'vitest';
import { IDLE_REFRESH_MS, freshAfterIdle } from '../src/browser/fresh-after-idle';

function fakeTransport() {
  const t = {
    client: 1,
    inits: 0,
    pending: [] as (() => void)[],
    async init() { this.inits++; this.client++; },
    /** Answers when release() is called; says which client sent it. */
    request(name: string): Promise<string> {
      const client = this.client;
      return new Promise(resolve => this.pending.push(() => resolve(name + '@' + client)));
    },
    release() { this.pending.splice(0).forEach(f => f()); }
  };
  return t;
}

describe('fresh epoxy client after a pause', () => {
  it('reuses the client within a page load, and starts a new one after a pause', async () => {
    let clock = 0;
    const t = freshAfterIdle(fakeTransport(), () => clock);
    clock = 50;
    const a = t.request('page');
    clock = 100;
    const b = t.request('script');            // while the page is loading
    await Promise.resolve();
    t.release();
    expect(await Promise.all([a, b])).toEqual(['page@1', 'script@1']);
    clock = 100 + IDLE_REFRESH_MS - 1;
    const c = t.request('image');              // shortly after: same client
    await Promise.resolve();
    t.release();
    expect(await c).toBe('image@1');
    expect(t.inits).toBe(0);

    clock += 6000;                             // the bot's pause between pages
    const d = t.request('next page');
    await new Promise(r => setTimeout(r, 0));
    t.release();
    expect(await d).toBe('next page@2');
    expect(t.inits).toBe(1);
  });

  it('never swaps the client while a request is still waiting, and swaps it once for requests arriving together', async () => {
    let clock = 0;
    const t = freshAfterIdle(fakeTransport(), () => clock);
    const slow = t.request('slow');
    clock = 10000;                             // a long wait for one answer isn't a pause
    const other = t.request('other');
    await Promise.resolve();
    t.release();
    expect(await Promise.all([slow, other])).toEqual(['slow@1', 'other@1']);
    expect(t.inits).toBe(0);

    clock = 20000;
    const both = [t.request('x'), t.request('y')];
    await new Promise(r => setTimeout(r, 0));
    t.release();
    expect(await Promise.all(both)).toEqual(['x@2', 'y@2']);
    expect(t.inits).toBe(1);
  });
});
