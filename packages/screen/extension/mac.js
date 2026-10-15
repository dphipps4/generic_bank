// The Mac identity's last part (plan, §5.1, §E.8): what neither a launch switch nor the DevTools
// Protocol can set, applied before any of the page's own scripts run. Everything else (the user
// agent and client hints, the languages, the cores, the screen size and pixel ratio, the timezone)
// is set by the browser itself and is not repeated here. The values are the reference capture's
// (tests/fixtures/browser/mac-chrome.json): a MacBook Air (M1). This file never reads the page; it
// only answers what the page asks the browser.
(() => {
  const MAC = {
    deviceMemory: 8,
    screen: { colorDepth: 30, pixelDepth: 30, menuBar: 30, dockAndMenuBar: 120 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      maxTextureSize: 16384,
    },
  };
  if (window.__gbMac) return;
  Object.defineProperty(window, '__gbMac', { value: true });

  // A replaced function must still print as the browser's own, however it is asked.
  const shown = new WeakMap();
  const toString = Function.prototype.toString;
  const own = {
    toString() {
      return shown.has(this) ? shown.get(this) : toString.call(this);
    },
  }.toString;
  const native = (fn, name) => (shown.set(fn, `function ${name}() { [native code] }`), fn);
  native(own, 'toString');
  Object.defineProperty(Function.prototype, 'toString', {
    value: own,
    writable: true,
    configurable: true,
  });

  // A getter where the browser keeps its own, on the prototype, so no instance carries a property.
  const getter = (proto, name, value) => {
    if (!proto) return;
    const was = Object.getOwnPropertyDescriptor(proto, name);
    const get = native(
      Object.getOwnPropertyDescriptor(
        {
          get [name]() {
            return value.call(this);
          },
        },
        name,
      ).get,
      `get ${name}`,
    );
    Object.defineProperty(proto, name, {
      get,
      set: undefined,
      enumerable: was ? was.enumerable : true,
      configurable: true,
    });
  };

  const nav = Navigator.prototype;
  getter(nav, 'deviceMemory', () => MAC.deviceMemory);

  // The display: 30-bit colour, and a working area short of the full height by the menu bar and
  // the Dock, measured from the screen's real height so the two always agree.
  const scr = Screen.prototype;
  const height = Object.getOwnPropertyDescriptor(scr, 'height').get;
  getter(scr, 'colorDepth', () => MAC.screen.colorDepth);
  getter(scr, 'pixelDepth', () => MAC.screen.pixelDepth);
  getter(scr, 'availTop', () => MAC.screen.menuBar);
  getter(scr, 'availHeight', function () {
    return Math.max(0, height.call(this) - MAC.screen.dockAndMenuBar);
  });

  // Web Share exists on a Mac and not on Linux. Without share data it is a TypeError, and without a
  // person's gesture (the crawler never makes one on a share button) it is refused, as on a Mac.
  const hasData = (d) =>
    !!d &&
    typeof d === 'object' &&
    ['url', 'text', 'title', 'files'].some((k) => d[k] !== undefined);
  const method = (obj, name, fn) => {
    if (name in obj) return;
    Object.defineProperty(obj, name, {
      value: native(fn, name),
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };
  method(
    nav,
    'share',
    {
      share() {
        return Promise.reject(
          hasData(arguments[0])
            ? new DOMException(
                "Failed to execute 'share' on 'Navigator': Must be handling a user gesture to perform a share request.",
                'NotAllowedError',
              )
            : new TypeError(
                "Failed to execute 'share' on 'Navigator': No known share data fields supplied. If using only new fields (other than title, text and url), you must feature-detect them first.",
              ),
        );
      },
    }.share,
  );
  method(
    nav,
    'canShare',
    {
      canShare() {
        return hasData(arguments[0]);
      },
    }.canShare,
  );

  // The graphics renderer: Apple's, through Metal, as every Apple-silicon Mac reports it.
  const GL = { VENDOR: 0x9245, RENDERER: 0x9246, MAX_TEXTURE_SIZE: 0x0d33 };
  for (const ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const proto = ctx && ctx.prototype;
    if (!proto) continue;
    const real = proto.getParameter;
    const replaced = native(
      {
        getParameter(p) {
          if (p === GL.VENDOR) return MAC.webgl.vendor;
          if (p === GL.RENDERER) return MAC.webgl.renderer;
          if (p === GL.MAX_TEXTURE_SIZE) return MAC.webgl.maxTextureSize;
          return real.call(this, p);
        },
      }.getParameter,
      'getParameter',
    );
    Object.defineProperty(proto, 'getParameter', {
      value: replaced,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
})();
