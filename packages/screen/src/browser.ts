// Chromium's headless shell, launched with a debugging pipe (no port anyone else can reach), and
// pages driven from outside. A frame from another origin runs in its own process; it is attached
// as a session of its own, so it can be read like any other frame.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { Cdp, CdpError, CdpTimeout, type Transport } from './cdp.js';
import { clientHints, type Identity, identityCommands, MAC, macChrome } from './identity.js';

/** Where Chrome is: CHROME_PATH, `just browser`'s install, or the Runner image's Debian chromium. */
export function findChrome(root = process.cwd()): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = resolve(root, '.run/browser/chrome');
  const inside =
    process.platform === 'darwin'
      ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      : 'chrome';
  if (existsSync(local)) {
    for (const v of readdirSync(local).sort().reverse()) {
      for (const sub of readdirSync(join(local, v))) {
        const bin = join(local, v, sub, inside);
        if (existsSync(bin)) return bin;
      }
    }
  }
  // Debian's /usr/bin/chromium is a shell script that does not exec: killing it would orphan the
  // browser. Start the real binary.
  for (const p of ['/usr/lib/chromium/chromium', '/usr/bin/chromium']) if (existsSync(p)) return p;
  throw new Error('No Chrome found: run `just browser`, or set CHROME_PATH.');
}

/** The identity extension (extension/mac.js), beside this package's source and its build. */
const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));

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
  /**
   * Origins to treat as secure, as HTTPS would make them: the banks, which Part 1 serves over plain
   * HTTP. Chrome sends its Sec-Fetch headers and client hints only to secure origins.
   */
  secureOrigins?: string[];
  /** The timezone the browser reports: the machine's own (plan, §E.8). */
  timezone?: string;
  /**
   * The only hosts (host and port) the page and its frames may reach. Every other request is
   * refused before it is sent (plan, §J.2, "Session guard: network").
   */
  hosts?: string[];
}

export class Browser {
  private constructor(
    readonly cdp: Cdp,
    private readonly child: ChildProcess,
    private readonly profile: string,
    readonly options: LaunchOptions,
    readonly identity: Identity,
  ) {}

  static async launch(o: LaunchOptions = {}): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'gb-chrome-'));
    const width = o.width ?? 1280;
    const height = o.height ?? 900;
    const bin = findChrome();
    const child = spawn(
      bin,
      [
        // Full Chrome runs in its modern headless mode; the headless shell is headless already.
        ...(/headless[-_]shell/.test(bin) ? [] : ['--headless=new']),

        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        // Never the machine's keychain or password store: on a Mac, full Chrome otherwise asks the
        // keychain for its "Chromium Safe Storage" key at every launch, a password prompt each time.
        '--use-mock-keychain',
        '--password-store=basic',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--mute-audio',
        // A branch workstation lets its console open windows: some consoles show search results
        // in a window a page opens as it loads, which a pop-up blocker would stop.
        '--disable-popup-blocking',
        '--hide-scrollbars',
        // Frames from another origin run in their own process and are attached as their own sessions.
        '--site-per-process',
        // No automation marker for the page to read (navigator.webdriver stays false).
        '--disable-blink-features=AutomationControlled',
        `--lang=${MAC.locale}`,
        // The identity extension is loaded over this pipe (Chrome ignores --load-extension).
        '--enable-unsafe-extension-debugging',
        // A Mac's display: wide color gamut and high dynamic range in CSS media queries, as the
        // engine itself answers them; screenshots keep their colors.
        '--force-color-profile=scrgb-linear',
        // Chrome on a Mac has Web Bluetooth; on Linux it sits behind this switch.
        '--enable-blink-features=WebBluetooth',
        ...(o.secureOrigins?.length
          ? [`--unsafely-treat-insecure-origin-as-secure=${o.secureOrigins.join(',')}`]
          : []),
        ...(process.platform === 'linux'
          ? [
              '--no-sandbox',
              '--disable-dev-shm-usage',
              // No GPU in the container: software WebGL, so a page still gets a WebGL context.
              '--use-gl=angle',
              '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader',
            ]
          : []),
        'about:blank',
      ],
      // Its own process group, so closing it can end every process it started, renderers included.
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    );
    child.stderr?.resume();
    const cdp = new Cdp(pipeTransport(child));
    const { product } = await cdp.call<{ product: string }>(
      'Browser.getVersion',
      {},
      { timeoutMs: 20_000 },
    );
    // The identity extension, before the first page exists, so its script runs in every page from
    // the first one (plan, §E.8). The headless shell has no extensions; full Chrome does.
    if (!/headless[-_]shell/.test(bin))
      await cdp.call(
        'Extensions.loadUnpacked',
        // Each page has a browser context of its own, which Chrome treats as incognito.
        { path: EXTENSION, enableInIncognito: true },
        { timeoutMs: 20_000 },
      );
    // The fingerprint, for this engine's own version (plan, §5.1).
    const timezone =
      o.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Browser(cdp, child, profile, { ...o, width, height }, macChrome(product, timezone));
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
    const page = new Page(this.cdp, targetId, sessionId, this.options, this.identity);
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

/** A document a new window received, exactly as the server sent it. */
export interface OpenedDocument {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export class Page {
  /** Sessions of frames from other origins, by their target id. */
  readonly frames = new Map<string, FrameSession>();
  /** Whether each frame, in any session, has fired its load event since it last navigated. */
  private readonly loaded = new Map<string, boolean>();
  private lastNavigationRequest = 0;
  /** A JavaScript dialog the page has open (it freezes the page until answered), or null. */
  dialog: { type: string; message: string; session: string } | null = null;
  /** Requests refused because their host is not allowed: host and path, never the query. */
  readonly refused: { host: string; path: string; document: boolean }[] = [];
  private offs: (() => void)[] = [];
  /** The page that opened this window; null for a page of its own. */
  opener: Page | null = null;

  constructor(
    readonly cdp: Cdp,
    readonly targetId: string,
    readonly sessionId: string,
    private readonly options: LaunchOptions,
    private readonly identity: Identity,
  ) {}

  call<R = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ) {
    return this.cdp.call<R>(method, params, { sessionId: this.sessionId, timeoutMs });
  }

  /**
   * Starts watching this page's events and gives it its identity: `window` for a window a page
   * opened, caught paused, which `resume` lets go once everything it needs has been sent.
   */
  async init(kind: 'page' | 'window' = 'page', resume?: () => Promise<unknown>) {
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
          // The frame waits, paused, until it has its identity, so its first request carries it.
          void this.prepare(child, 'frame')
            .catch(() => undefined)
            .finally(() =>
              this.cdp
                .call('Runtime.runIfWaitingForDebugger', {}, { sessionId: child })
                .catch(() => undefined),
            );
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
        if (
          e.method === 'Fetch.requestPaused' &&
          this.options.hosts &&
          (e.sessionId === this.sessionId ||
            [...this.frames.values()].some((f) => f.sessionId === e.sessionId))
        ) {
          const p = e.params as {
            requestId: string;
            request: { url: string };
            resourceType: string;
          };
          const u = new URL(p.request.url);
          const allowed = !/^(http|ws)s?:$/.test(u.protocol) || this.options.hosts.includes(u.host);
          const document = p.resourceType === 'Document';
          if (!allowed) this.refused.push({ host: u.host, path: u.pathname, document });
          // A refused page is answered "No Content", so the frame stays where it was rather than
          // showing an error page; anything else simply fails.
          const [method, params] = allowed
            ? ['Fetch.continueRequest', {}]
            : document
              ? ['Fetch.fulfillRequest', { responseCode: 204 }]
              : ['Fetch.failRequest', { errorReason: 'BlockedByClient' }];
          void this.cdp
            .call(method, { requestId: p.requestId, ...params }, { sessionId: e.sessionId })
            .catch(() => undefined);
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
    // A window's requests pass the same host guard as its opener's.
    const guard: [string, Record<string, unknown>][] =
      kind === 'window' && this.options.hosts
        ? [['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }]]
        : [];
    await this.prepare(this.sessionId, kind, { extra: guard, resume });
  }

  /**
   * The window an action opens (a page of search results), as a page of its own to read and act
   * on. The window is caught before its first request and given this page's identity, so it is
   * the same browser to the bank. The caller closes it when done, if the window has not closed
   * itself.
   */
  async openedWindow(action: () => Promise<unknown>, timeoutMs = 30_000): Promise<Page> {
    const cdp = this.cdp;
    let off = () => {};
    const caught = new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpTimeout('a new window', timeoutMs)), timeoutMs);
      let taken: string | null = null;
      off = cdp.on((e) => {
        if (e.method !== 'Target.attachedToTarget' || e.sessionId) return;
        const info = e.params.targetInfo as { targetId: string; openerId?: string };
        const sessionId = e.params.sessionId as string;
        const go = (s: string) => cdp.call('Runtime.runIfWaitingForDebugger', {}, { sessionId: s });
        // The window's own session, attached below, is announced too: it is kept.
        if (taken === info.targetId) return;
        const ours =
          info.openerId === this.targetId || (!!info.openerId && this.frames.has(info.openerId));
        if (!ours || taken || e.params.waitingForDebugger !== true) {
          // Any other page, this one included: let it go on, and let go of it.
          void go(sessionId)
            .catch(() => undefined)
            .then(() => cdp.call('Target.detachFromTarget', { sessionId }))
            .catch(() => undefined);
          return;
        }
        taken = info.targetId;
        // A session of its own: the one it was caught by ends when catching stops.
        void cdp
          .call<{ sessionId: string }>('Target.attachToTarget', {
            targetId: info.targetId,
            flatten: true,
          })
          .then(async ({ sessionId: own }) => {
            const w = new Page(cdp, info.targetId, own, this.options, this.identity);
            w.opener = this;
            await w.init('window', () => go(sessionId));
            return w;
          })
          .then(
            (w) => {
              clearTimeout(timer);
              resolve(w);
            },
            (err: Error) => {
              clearTimeout(timer);
              reject(err);
            },
          );
      });
    });
    caught.catch(() => undefined);
    await cdp.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'page' }],
    });
    try {
      await action();
      return await caught;
    } finally {
      off();
      await cdp
        .call('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        .catch(() => undefined);
    }
  }

  /** What every session needs: page events, the layout domains, auto-attach, extra headers. */
  private async prepare(
    sessionId: string,
    kind: 'page' | 'frame' | 'window',
    o: { extra?: [string, Record<string, unknown>][]; resume?: () => Promise<unknown> } = {},
  ) {
    const commands: [string, Record<string, unknown>][] = [];
    // The identity first, before anything this session loads (plan, §E.8). Screen metrics belong to
    // the page; a frame takes the rest. A window this page opened already has the page's locale.
    for (const [method, params] of identityCommands(this.identity, {
      width: this.options.width ?? 1280,
      height: this.options.height ?? 900,
    })) {
      if (kind === 'frame' && method === 'Emulation.setDeviceMetricsOverride') continue;
      commands.push([method, params as Record<string, unknown>]);
    }
    // A window this page opened has its own interception (openedDocument).
    if (this.options.hosts && kind !== 'window')
      commands.push(['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }]);
    commands.push(
      ['Page.enable', {}],
      ['Page.setLifecycleEventsEnabled', { enabled: true }],
      ['DOM.enable', {}],
      ['Network.enable', {}],
    );
    const headers = {
      ...this.options.headers,
      ...(kind === 'window' ? clientHints(this.identity) : {}),
    };
    if (Object.keys(headers).length) commands.push(['Network.setExtraHTTPHeaders', { headers }]);
    commands.push(
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
      ...(o.extra ?? []),
    );
    const send = ([method, params]: [string, Record<string, unknown>]) =>
      this.cdp.call(method, params, { sessionId }).catch((e: unknown) => {
        if (kind === 'window' && e instanceof CdpError && /already in effect/.test(e.message))
          return;
        throw e;
      });
    if (kind !== 'window') {
      for (const command of commands) await send(command);
      return;
    }
    // A window opened without its opener has no renderer until it is let go, and some answers wait
    // for one. Every command is sent, and so takes effect, before the window goes on; the answers
    // are awaited after.
    const answers = commands.map(send);
    answers.forEach((a) => a.catch(() => undefined));
    await o.resume?.();
    await Promise.all(answers);
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

  /**
   * The document an action opens in a new window (a statement's PDF), as the server sent it. The
   * window is caught before its first request, given this page's identity, and read at the network
   * layer when its response arrives; then it is closed. Nothing runs in it, and it is never asked
   * for the document a second time. With `orNavigation`, an action that navigates this page
   * instead, and opens no window, answers null: the document is then on its way to this page.
   */
  async openedDocument(action: () => Promise<unknown>, timeoutMs?: number): Promise<OpenedDocument>;
  async openedDocument(
    action: () => Promise<unknown>,
    timeoutMs: number,
    o: { orNavigation: true },
  ): Promise<OpenedDocument | null>;
  async openedDocument(
    action: () => Promise<unknown>,
    timeoutMs = 30_000,
    o: { orNavigation?: boolean } = {},
  ): Promise<OpenedDocument | null> {
    const cdp = this.cdp;
    let popup: { sessionId: string; targetId: string } | null = null;
    let off = () => {};
    let timer: NodeJS.Timeout | undefined;
    const caught = new Promise<OpenedDocument>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new CdpTimeout('a document in a new window', timeoutMs)),
        timeoutMs,
      );
      const done = (f: () => void) => {
        clearTimeout(timer);
        f();
      };
      off = cdp.on((e) => {
        if (e.method === 'Target.attachedToTarget' && !e.sessionId) {
          const info = e.params.targetInfo as { targetId: string; openerId?: string };
          const sessionId = e.params.sessionId as string;
          const go = (s: string) =>
            cdp.call('Runtime.runIfWaitingForDebugger', {}, { sessionId: s });
          // Only a window opened now is the one: a window still open from before is not.
          if (info.openerId !== this.targetId || popup || e.params.waitingForDebugger !== true) {
            // Any other page, this one included: let it go on, and let go of it.
            void go(sessionId)
              .catch(() => undefined)
              .then(() => cdp.call('Target.detachFromTarget', { sessionId }))
              .catch(() => undefined);
            return;
          }
          popup = { sessionId, targetId: info.targetId };
          const caughtAt = [
            { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
          ];
          void this.prepare(sessionId, 'window', {
            extra: [['Fetch.enable', { patterns: caughtAt }]],
            resume: () => go(sessionId),
          }).catch((err: Error) => done(() => reject(err)));
          return;
        }
        if (e.method !== 'Fetch.requestPaused' || !popup || e.sessionId !== popup.sessionId) return;
        const p = e.params as {
          requestId: string;
          request: { url: string };
          responseStatusCode?: number;
          responseHeaders?: { name: string; value: string }[];
          responseErrorReason?: string;
        };
        const sessionId = popup.sessionId;
        const status = p.responseStatusCode ?? 0;
        if (status >= 300 && status < 400) {
          void cdp
            .call('Fetch.continueRequest', { requestId: p.requestId }, { sessionId })
            .catch(() => undefined);
          return;
        }
        void (async () => {
          if (p.responseErrorReason || !status)
            throw new Error(`the new window's request failed: ${p.responseErrorReason ?? ''}`);
          const r = await cdp.call<{ body: string; base64Encoded: boolean }>(
            'Fetch.getResponseBody',
            { requestId: p.requestId },
            { sessionId, timeoutMs },
          );
          const contentType =
            p.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
          // The window has nothing more to do with it.
          await cdp
            .call(
              'Fetch.failRequest',
              { requestId: p.requestId, errorReason: 'Aborted' },
              { sessionId },
            )
            .catch(() => undefined);
          done(() =>
            resolve({
              url: p.request.url,
              status,
              contentType,
              body: Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8'),
            }),
          );
        })().catch((err: Error) => done(() => reject(err)));
      });
    });
    caught.catch(() => undefined);
    // Pages are caught paused only while the action runs.
    await cdp.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'page' }],
    });
    const since = Date.now();
    let over = false;
    try {
      await action();
      if (!o.orNavigation) return await caught;
      // A window is announced as the action opens it; a page that navigates instead, with no window
      // a moment later, has its document coming to it.
      const navigated = (async () => {
        while (!over) {
          if (popup) return caught;
          const at = this.lastNavigationRequest;
          if (at >= since && Date.now() - at > 1500) return null;
          if (Date.now() - since > timeoutMs) return caught;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      })();
      return await Promise.race([caught, navigated]);
    } finally {
      over = true;
      clearTimeout(timer);
      off();
      await cdp
        .call('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        .catch(() => undefined);
      const p = popup as { targetId: string } | null;
      if (p) await this.closeWindow(p.targetId);
    }
  }

  /**
   * Closes a window and waits until it is gone: a page opening a window by the same name while the
   * old one is still closing would load into the old one.
   */
  private async closeWindow(targetId: string) {
    await this.cdp.call('Target.closeTarget', { targetId }).catch(() => undefined);
    for (let i = 0; i < 50; i++) {
      const { targetInfos } = await this.cdp
        .call<{ targetInfos: { targetId: string }[] }>('Target.getTargets')
        .catch(() => ({ targetInfos: [] }));
      if (!targetInfos.some((t) => t.targetId === targetId)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
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

  /**
   * The viewport as a picture, one image pixel per CSS pixel: the page is drawn at the Mac's pixel
   * ratio, and the picture is taken at that ratio's inverse, so fingerprints and masks keep the
   * screen model's coordinates.
   */
  async screenshot(): Promise<Buffer> {
    const r = await this.call<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: this.options.width ?? 1280,
        height: this.options.height ?? 900,
        scale: 1 / MAC.devicePixelRatio,
      },
    });
    return Buffer.from(r.data, 'base64');
  }

  async close() {
    for (const off of this.offs) off();
    await this.cdp.call('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}
