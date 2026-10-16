// The browser's fingerprint (plan, §5.1, §E.8, Appendix W): Chrome on an Apple-silicon Mac. Every
// value is set over the DevTools Protocol before the first navigation, from outside the page; no
// script is ever run inside a bank's page to change what it sees. The values come from a reference
// capture of a real Mac (tests/fixtures/browser/mac-chrome.json). What cannot be set that way stays
// the container's own, and is listed in LINUX_TELLS.

/** The Mac the browser presents: a MacBook Air (M1), as captured. */
export const MAC = {
  platform: 'MacIntel',
  platformVersion: '26.6.2',
  architecture: 'arm',
  bitness: '64',
  screen: { width: 1440, height: 900 },
  devicePixelRatio: 2,
  cores: 8,
  languages: ['en-US', 'en'],
  // Chrome adds the weights itself: en-US,en goes out as en-US,en;q=0.9 and navigator.languages
  // reads ['en-US', 'en']. Weights given here would be doubled.
  acceptLanguages: 'en-US,en',
  locale: 'en-US',
} as const;

/**
 * The one difference from a real Mac's Chrome that the browser's own controls leave: with its user
 * agent overridden, Chrome sends Accept-Language right after the client hints rather than last. The
 * value is exact. Everything a page's scripts can see matches the reference capture.
 */
export const HEADER_TELLS = ['accept-language'] as const;

/**
 * The brand list Chrome itself produces for a major version (Chromium's user-agent brand
 * algorithm): a placeholder brand and version chosen from the version number, and an order that
 * depends on it. It is computed, never chosen: for 155 it is exactly what Chrome 155 sends.
 */
export function brandsFor(major: number, version: string = String(major)) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseVersions = ['8', '99', '24'];
  const grease = {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: greaseVersions[major % greaseVersions.length]!,
  };
  const full = version === String(major) ? null : `${grease.version}.0.0.0`;
  const list = [
    { brand: grease.brand, version: full ?? grease.version },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  ];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const order = orders[major % orders.length]!;
  const out: typeof list = [];
  list.forEach((b, i) => (out[order[i]!] = b));
  return out;
}

export interface Identity {
  userAgent: string;
  /** The value of Emulation.setUserAgentOverride: the user agent and its client hints. */
  override: Record<string, unknown>;
  timezone: string;
}

/** The identity for the browser's own engine version (from Browser.getVersion's product). */
export function macChrome(product: string, timezone: string): Identity {
  const full = /\/([\d.]+)/.exec(product)?.[1] ?? '0.0.0.0';
  const major = Number(full.split('.')[0]);
  // Chrome reports this exact string on every Mac, Apple silicon included (plan, §W.1).
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return {
    userAgent,
    timezone,
    override: {
      userAgent,
      acceptLanguage: MAC.acceptLanguages,
      platform: MAC.platform,
      userAgentMetadata: {
        brands: brandsFor(major),
        fullVersionList: brandsFor(major, full),
        fullVersion: full,
        platform: 'macOS',
        platformVersion: MAC.platformVersion,
        architecture: MAC.architecture,
        model: '',
        mobile: false,
        bitness: MAC.bitness,
        wow64: false,
      },
    },
  };
}

/** The commands that give one session (a page, a frame, a popup) its identity, in order. */
export function identityCommands(id: Identity, viewport: { width: number; height: number }) {
  return [
    ['Emulation.setUserAgentOverride', id.override],
    ['Emulation.setLocaleOverride', { locale: MAC.locale }],
    ['Emulation.setTimezoneOverride', { timezoneId: id.timezone }],
    ['Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: MAC.cores }],
    [
      'Emulation.setDeviceMetricsOverride',
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: MAC.devicePixelRatio,
        mobile: false,
        screenWidth: MAC.screen.width,
        screenHeight: MAC.screen.height,
      },
    ],
  ] as const;
}

/**
 * The low-entropy client hints Chrome sends with every request, as this identity's metadata gives
 * them. Chrome derives them from the metadata itself, except on the first request of a window
 * opened without its opener, which gets the engine's own; such a window carries these instead.
 */
export function clientHints(id: Identity): Record<string, string> {
  const m = id.override.userAgentMetadata as {
    brands: { brand: string; version: string }[];
    mobile: boolean;
    platform: string;
  };
  return {
    'sec-ch-ua': m.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-mobile': m.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${m.platform}"`,
  };
}
