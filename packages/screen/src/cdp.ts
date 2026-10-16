// A small client for the Chrome DevTools Protocol. We read the browser from outside the page: no
// script of ours ever runs in a bank's page, and every call has its own timeout, because a frozen
// DevTools session never times out by itself (plan, §5).

/** Where messages go: Chromium's debugging pipe in the Runner, anything in tests. */
export interface Transport {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export class CdpTimeout extends Error {
  constructor(
    public readonly method: string,
    public readonly ms: number,
  ) {
    super(`${method} did not answer within ${ms} ms`);
    this.name = 'CdpTimeout';
  }
}

export class CdpError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class CdpClosed extends Error {
  constructor(method: string) {
    super(`${method}: the browser connection is closed`);
    this.name = 'CdpClosed';
  }
}

type Params = Record<string, unknown>;
type Event = { method: string; params: Params; sessionId?: string };

export interface CallOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export class Cdp {
  private nextId = 1;
  private pending = new Map<
    number,
    { method: string; resolve(v: Params): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  private listeners = new Set<(e: Event) => void>();
  private closed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((raw) => this.receive(raw));
    transport.onClose(() => this.shutdown());
  }

  /** Calls a method and waits for its answer, or fails after the timeout. */
  call<R = Params>(method: string, params: Params = {}, o: CallOptions = {}): Promise<R> {
    if (this.closed) return Promise.reject(new CdpClosed(method));
    const id = this.nextId++;
    const ms = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(method, ms));
      }, ms);
      this.pending.set(id, { method, resolve: resolve as (v: Params) => void, reject, timer });
      this.transport.send(
        JSON.stringify({ id, method, params, ...(o.sessionId ? { sessionId: o.sessionId } : {}) }),
      );
    });
  }

  /** Every event, from every session. Returns a function that stops listening. */
  on(listener: (e: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The next event that matches, or a timeout. */
  waitFor(match: (e: Event) => boolean, timeoutMs: number, what = 'event'): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpTimeout(what, timeoutMs));
      }, timeoutMs);
      const off = this.on((e) => {
        if (!match(e)) return;
        clearTimeout(timer);
        off();
        resolve(e);
      });
    });
  }

  get isClosed() {
    return this.closed;
  }

  close() {
    this.transport.close();
    this.shutdown();
  }

  private receive(raw: string) {
    let msg: {
      id?: number;
      result?: Params;
      error?: { code: number; message: string };
      method?: string;
      params?: Params;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const e: Event = {
        method: msg.method,
        params: msg.params ?? {},
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      };
      for (const l of [...this.listeners]) l(e);
    }
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpClosed(p.method));
    }
    this.pending.clear();
  }
}
