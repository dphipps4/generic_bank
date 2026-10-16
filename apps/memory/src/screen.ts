// The privacy screen (plan §K.5), on every write: no passwords, codes, cookies or tokens, no
// account-like numbers, no screenshots or page data, nothing about a person, and no advice to do
// a forbidden action. It is blunt on purpose. A refusal names the rule and where, never the value.

export type Screened = { ok: true } | { ok: false; reason: string; path: string };

// A key that names a secret or a picture refuses its value, whatever it is.
const SECRET_KEY =
  /^(password|passcode|passwd|pin|otp|one[-_]?time[-_]?code|code|cookies?|set[-_]?cookie|token|access[-_]?token|refresh[-_]?token|secret|api[-_]?key|authorization|ssn|screenshot|image|png|html|dom)$/i;

// Ids, hashes and times are structure, checked by each write's own shape; they are skipped when
// they look like one. A curated entry's key is its id: a lesson a run proposed is keyed by a UUID.
const STRUCTURAL_KEY = /^(id|key|run|frame|frames|hash|.*Id|.*Ids|.*Hash|.*At)$/;
const STRUCTURAL_VALUE = /^[\w.:/+-]{1,128}$/;

const VALUE: [reason: string, pattern: RegExp][] = [
  ['screenshot', /data:image\/|\b(iVBORw0KGgo|\/9j\/4)/i],
  ['page data', /<\s*(html|head|body|form|input|div|table|script|iframe)\b/i],
  ['token', /\beyJ[\w-]{8,}\.[\w-]{8,}|\bbearer\s+[\w.~+/-]{8,}/i],
  ['token', /(?=[\w+/=-]*\d)(?=[\w+/=-]*[a-z])[\w+/=-]{32,}/i],
  ['cookie', /\b(set-)?cookie\s*:|\b\w+=[\w%.-]{16,}/i],
  [
    'password',
    /\b(password|passcode|passphrase|secret|api key)\b(\s*[=:]\s*\S|\s+(is|was)\s+(["'`]|(?=\S*[\d!@#$%^&*])\S{4,}))/i,
  ],
  ['code', /\b(code|otp|pin|passcode)\b\D{0,15}\b\d{4,8}\b/i],
  ['token', /\btoken\b\s*[=:]\s*\S/i],
  ['person', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
];

// Dates, times and UUIDs are many digits, but no account.
const NOT_AN_ACCOUNT =
  /\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi;
const ACCOUNT = /\d(?:[ -]?\d){7,}/;

// What memory never advises (the plan's rules, and §O.3), unless the words just before it say not
// to. A comma ends that reach: "if the code does not arrive, request another" is still advice.
const FORBIDDEN = [
  /\b(request|ask for|send|resend|trigger|get)\b[^.]{0,30}\b(second|another|new|fresh|extra)\b[^.]{0,15}\bcode\b/i,
  /\b(submit|enter|type|retype|resubmit|re-enter|retry|try)\b[^.]{0,30}\bpassword\b[^.]{0,20}\b(again|twice|second time)\b/i,
  /\b(bypass|solve|evade|defeat|circumvent|get around|beat)\b[^.]{0,30}\b(captcha|bot detection|bot check|rate limit)/i,
  /\bspoof|\b(rotate|rotating|residential)\s+prox|\bfingerprint[^.]{0,20}\b(randomi[sz]e|fake|mask)/i,
  /\b(move|send|transfer|submit)\b[^.]{0,40}\b(money|funds|transfer|payment)\b[^.]{0,40}\bwithout\b/i,
  /\b(skip|bypass|disable|ignore)\s+(the\s+|a\s+|any\s+|its\s+)?(\w+\s+)?(approval|grant|guard|allowlist)/i,
];
const NEGATED =
  /\b(never|not|no|don't|do not|cannot|can't|must not|won't|nor|avoid|rather than|instead of)\s+([\w'-]+\s+){0,3}$/i;

function advisesForbidden(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n/)) {
    for (const re of FORBIDDEN) {
      const m = re.exec(sentence);
      if (m && !NEGATED.test(sentence.slice(0, m.index))) return true;
    }
  }
  return false;
}

function screenText(s: string): string | undefined {
  for (const [reason, re] of VALUE) if (re.test(s)) return reason;
  if (ACCOUNT.test(s.replace(NOT_AN_ACCOUNT, ' '))) return 'account number';
  if (advisesForbidden(s)) return 'forbidden action';
  return undefined;
}

export function screen(value: unknown, path = '', key = ''): Screened {
  if (typeof value === 'string') {
    if (STRUCTURAL_KEY.test(key) && STRUCTURAL_VALUE.test(value)) return { ok: true };
    const reason = screenText(value);
    return reason ? { ok: false, reason, path: path || '(body)' } : { ok: true };
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const r = screen(v, `${path}[${i}]`, key);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const at = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k)) return { ok: false, reason: k.toLowerCase(), path: at };
      const r = screen(v, at, k);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}
