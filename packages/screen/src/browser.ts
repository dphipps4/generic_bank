// Chromium's headless shell, launched with a debugging pipe (no port anyone else can reach), and
// pages driven from outside. A frame from another origin runs in its own process; it is attached
// as a session of its own, so it can be read like any other frame.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Cdp, type Transport } from './cdp.js';

/** Where the headless shell is: CHROME_PATH, `make browser`'s install, or the Runner image's. */
export function findChrome(root = process.cwd()): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = resolve(root, '.run/browser/chrome-headless-shell');
  if (existsSync(local)) {
    for (const v of readdirSync(local).sort().reverse()) {
      for (const sub of readdirSync(join(local, v))) {
        const bin = join(local, v, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  // Debian's /usr/bin/chromium-headless-shell is a shell script that does not exec: killing it
  // would orphan the browser. Start the real binary.
  for (const p of ['/usr/lib/chromium/chromium-headless-shell', '/usr/bin/chromium-headless-shell'])
    if (existsSync(p)) return p;
  throw new Error('No headless Chromium found: run `make browser`, or set CHROME_PATH.');
}

/** Ends the browser and every process in its group. */
function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Chromium's debugging pipe: it reads commands on fd 3 and writes on fd 4, NUL-separated. */
function pipeTransport(child: ChildProcess): Transport {
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  let buffer = '';
  const messageListeners: ((m: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  fromChrome.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let i: number;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const m = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      for (const l of messageListeners) l(m);
    }
  });
  let done = false;
  const closed = () => {
    if (done) return;
    done = true;
    closeListeners.forEach((l) => l());
  };
  fromChrome.on('close', closed);
  // When the browser is killed, its pipe can fail with ECONNRESET or EPIPE: that is the browser
  // going away, not an error that may crash the process.
  fromChrome.on('error', closed);
  toChrome.on('error', closed);
  child.on('exit', closed);
  return {
    send: (m) => {
      if (!toChrome.destroyed) toChrome.write(`${m}\0`);
    },
    onMessage: (l) => messageListeners.push(l),
    onClose: (l) => closeListeners.push(l),
    close: () => {
      toChrome.end();
      killGroup(child);
    },
  };
}

export interface LaunchOptions {
  width?: number;
  height?: number;
  /** Extra headers on every request, such as a signed X-Hazards in tests. */
  headers?: Record<string, string>;
}

export class Browser {
  private constructor(
    readonly cdp: Cdp,
    private readonly child: ChildProcess,
    private readonly profile: string,
    readonly options: LaunchOptions,
  ) {}

  static async launch(o: LaunchOptions = {}): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'gb-chrome-'));
    const width = o.width ?? 1280;
    const height = o.height ?? 900;
    const child = spawn(
      findChrome(),
      [
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--mute-audio',
        '--hide-scrollbars',
        // Frames from another origin run in their own process and are attached as their own sessions.
        '--site-per-process',
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        'about:blank',
      ],
      // Its own process group, so closing it can end every process it started, renderers included.
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    );
    child.stderr?.resume();
    const cdp = new Cdp(pipeTransport(child));
    await cdp.call('Browser.getVersion', {}, { timeoutMs: 20_000 });
    return new Browser(cdp, child, profile, { ...o, width, height });
  }

  /**
   * A new page in a browser context of its own: its own cookies and storage, as a fresh browser
   * would have, with its frames from other origins attached too.
   */
  async newPage(): Promise<Page> {
    const { browserContextId } = await this.cdp.call<{ browserContextId: string }>(
      'Target.createBrowserContext',
      { disposeOnDetach: true },
    );
    const { targetId } = await this.cdp.call<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await this.cdp.call<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(this.cdp, targetId, sessionId, this.options);
    await page.init();
    return page;
  }

  async close() {
    const exited = new Promise<void>((done) => {
      if (this.child.exitCode !== null) return done();
      this.child.once('exit', () => done());
    });
    try {
      await this.cdp.call('Browser.close', {}, { timeoutMs: 3000 });
    } catch {
      // closing anyway
    }
    this.cdp.close();
    killGroup(this.child);
    // Chromium writes to its profile until it has exited; only then can the profile go.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface FrameSession {
  sessionId: string;
  targetId: string;
  url: string;
}

export class Page {
  /** Sessions of frames from other origins, by their target id. */
  readonly frames = new Map<string, FrameSession>();
  /** Whether each frame, in any session, has fired its load event since it last navigated. */
  private readonly loaded = new Map<string, boolean>();
  private lastNavigationRequest = 0;
  /** A JavaScript dialog the page has open (it freezes the page until answered), or null. */
  dialog: { type: string; message: string; session: string } | null = null;
  private offs: (() => void)[] = [];

  constructor(
    readonly cdp: Cdp,
    readonly targetId: string,
    readonly sessionId: string,
    private readonly options: LaunchOptions,
  ) {}

  call<R = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ) {
    return this.cdp.call<R>(method, params, { sessionId: this.sessionId, timeoutMs });
  }

  async init() {
    // Child frames from other origins attach automatically; each gets the same headers.
    this.offs.push(
      this.cdp.on((e) => {
        if (e.method === 'Target.attachedToTarget' && e.sessionId === this.sessionId) {
          const info = e.params.targetInfo as { targetId: string; type: string; url: string };
          const child = e.params.sessionId as string;
          if (info.type !== 'iframe') return;
          this.frames.set(info.targetId, {
            sessionId: child,
            targetId: info.targetId,
            url: info.url,
          });
          void this.prepare(child).catch(() => undefined);
        }
        if (e.method === 'Target.detachedFromTarget' && e.sessionId === this.sessionId) {
          this.frames.delete(e.params.targetId as string);
        }
        if (
          e.sessionId === this.sessionId ||
          [...this.frames.values()].some((f) => f.sessionId === e.sessionId)
        ) {
          if (e.method === 'Page.frameNavigated')
            this.loaded.set((e.params.frame as { id: string }).id, false);
          if (e.method === 'Page.frameStartedLoading')
            this.loaded.set(e.params.frameId as string, false);
          // A navigation is "not loaded" from the moment it is requested, before it has started.
          if (
            e.method === 'Page.frameRequestedNavigation' ||
            e.method === 'Page.frameScheduledNavigation'
          ) {
            this.loaded.set(e.params.frameId as string, false);
            this.lastNavigationRequest = Date.now();
          }
          if (e.method === 'Page.lifecycleEvent' && e.params.name === 'load')
            this.loaded.set(e.params.frameId as string, true);
          if (e.method === 'Page.frameStoppedLoading')
            this.loaded.set(e.params.frameId as string, true);
          if (e.method === 'Page.frameDetached') this.loaded.delete(e.params.frameId as string);
        }
        if (e.method === 'Page.javascriptDialogOpening') {
          this.dialog = {
            type: e.params.type as string,
            message: e.params.message as string,
            session: e.sessionId ?? this.sessionId,
          };
        }
        if (e.method === 'Page.javascriptDialogClosed') this.dialog = null;
        if (e.method === 'Target.targetInfoChanged') {
          const info = e.params.targetInfo as { targetId: string; url: string };
          const f = this.frames.get(info.targetId);
          if (f) f.url = info.url;
        }
      }),
    );
    await this.prepare(this.sessionId);
    await this.call('Emulation.setDeviceMetricsOverride', {
      width: this.options.width,
      height: this.options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** What every session needs: page events, the layout domains, auto-attach, extra headers. */
  private async prepare(sessionId: string) {
    const c = (m: string, p: Record<string, unknown> = {}) => this.cdp.call(m, p, { sessionId });
    await c('Page.enable');
    await c('Page.setLifecycleEventsEnabled', { enabled: true });
    await c('DOM.enable');
    await c('Network.enable');
    if (this.options.headers)
      await c('Network.setExtraHTTPHeaders', { headers: this.options.headers });
    await c('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  /** Navigates, and waits for the top document's load event. */
  async goto(url: string, timeoutMs = 45_000) {
    const loaded = this.cdp.waitFor(
      (e) => e.method === 'Page.loadEventFired' && e.sessionId === this.sessionId,
      timeoutMs,
      `load of ${url}`,
    );
    const r = await this.call<{ errorText?: string }>('Page.navigate', { url }, timeoutMs);
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
    await loaded;
  }

  /**
   * After an action: gives any navigation it caused a moment to announce itself, so the next
   * reading is not taken from a page that is about to go away.
   */
  async settle(ms = 250): Promise<boolean> {
    const since = Date.now();
    while (Date.now() - since < ms) {
      if (this.lastNavigationRequest >= since) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  /** Answers the open dialog: accept (OK) or dismiss (Cancel). */
  async answerDialog(accept: boolean) {
    const d = this.dialog;
    if (!d) return;
    await this.cdp.call('Page.handleJavaScriptDialog', { accept }, { sessionId: d.session });
    this.dialog = null;
    await this.settle();
  }

  /** True when the top document and every frame have fired their load event. */
  allLoaded(): boolean {
    return this.loaded.size > 0 && [...this.loaded.values()].every(Boolean);
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }

  async close() {
    for (const off of this.offs) off();
    await this.cdp.call('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}
