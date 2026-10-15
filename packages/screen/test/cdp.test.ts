import { describe, expect, it } from 'vitest';
import { Cdp, CdpClosed, CdpError, CdpTimeout, type Transport } from '../src/cdp.js';

/** A transport we control: it records what is sent and answers only when told to. */
function fake() {
  const sent: { id: number; method: string; sessionId?: string }[] = [];
  let listener: (m: string) => void = () => undefined;
  let closer: () => void = () => undefined;
  const t: Transport = {
    send: (m) => sent.push(JSON.parse(m)),
    onMessage: (l) => (listener = l),
    onClose: (l) => (closer = l),
    close: () => closer(),
  };
  return { t, sent, answer: (o: object) => listener(JSON.stringify(o)), drop: () => closer() };
}

describe('the DevTools client', () => {
  it('answers a call with its result, matched by id, on the right session', async () => {
    const f = fake();
    const cdp = new Cdp(f.t);
    const p = cdp.call('DOM.getDocument', { depth: 1 }, { sessionId: 's1' });
    expect(f.sent[0]).toMatchObject({ method: 'DOM.getDocument', sessionId: 's1' });
    f.answer({ id: f.sent[0]!.id, result: { root: { nodeId: 1 } } });
    expect(await p).toEqual({ root: { nodeId: 1 } });
  });

  it('times out a call that never answers, instead of hanging', async () => {
    const cdp = new Cdp(fake().t);
    const t0 = Date.now();
    await expect(cdp.call('Page.captureScreenshot', {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      CdpTimeout,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('turns a protocol error into an error naming the method', async () => {
    const f = fake();
    const cdp = new Cdp(f.t);
    const p = cdp.call('Nope.method');
    f.answer({ id: f.sent[0]!.id, error: { code: -32601, message: "'Nope.method' wasn't found" } });
    await expect(p).rejects.toBeInstanceOf(CdpError);
  });

  it('fails every waiting call when the browser goes away, and every later one at once', async () => {
    const f = fake();
    const cdp = new Cdp(f.t);
    const p = cdp.call('Page.navigate', { url: 'x' }, { timeoutMs: 60_000 });
    f.drop();
    await expect(p).rejects.toBeInstanceOf(CdpClosed);
    await expect(cdp.call('Page.enable')).rejects.toBeInstanceOf(CdpClosed);
  });

  it('waits for an event, or times out', async () => {
    const f = fake();
    const cdp = new Cdp(f.t);
    const w = cdp.waitFor((e) => e.method === 'Page.loadEventFired', 1000);
    f.answer({ method: 'Network.requestWillBeSent', params: {} });
    f.answer({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's1' });
    expect((await w).sessionId).toBe('s1');
    await expect(cdp.waitFor(() => false, 30)).rejects.toBeInstanceOf(CdpTimeout);
  });
});
