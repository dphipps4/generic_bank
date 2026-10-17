// Bank profiles for CoreLink Branch Console, each written by hand. The factory starts from a bank's
// base below and writes its own over it. The console's address comes from the registry at run time.
import type { ResultCode } from '@gb/contracts';
import type { KnownPicture } from '@gb/screen';
import type { Profile } from '../sdk.js';

/** The product's own words for each refusal: every CoreLink bank uses them. */
const REFUSALS: Profile['refusals'] = [
  { text: 'The amount is more than the available balance.', code: 'insufficient_funds' },
  { text: 'Transfers from this account type are not permitted.', code: 'permission_denied' },
  {
    text: 'Your operator role cannot transfer more than $10,000 per day.',
    code: 'limit_exceeded',
  },
  { text: 'Enter an amount between $0.01 and $25,000.00.', code: 'invalid_amount' },
  {
    text: 'This account is restricted. Refer the member to a branch.',
    code: 'account_restricted',
  },
];

export const GENERIC_BANK: Omit<Profile, 'url'> = {
  bank: 'generic',
  words: {
    operatorId: ['Operator ID'],
    password: ['Password'],
    signIn: ['Sign In'],
    memberSearch: ['Member Search'],
    memberNumber: ['Member number'],
    search: ['Search'],
    transfer: ['Transfer Funds'],
    continue: ['Continue'],
    submitTransfer: ['Submit transfer'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  accountWording: /Account ending in (\d{4})/,
  codeStyle: 'sent',
  pictures: [],
  safePictures: [],
};

const EXAMPLE_PICTURES: KnownPicture[] = [
  {
    name: 'Username:',
    hash: '000000002912a540212a950d232ade0c293366402e629d2d892add04d90add45',
    aspect: 6.22,
  },
  {
    name: 'Passcode:',
    hash: '00000000899324c0a522d50d26225d0c99925d40145add2d17122404173324c5',
    aspect: 6.22,
  },
  {
    name: 'Member number:',
    hash: '108442116351535148915a924891549a69515751489152924a11624a63416348',
    aspect: 9.56,
  },
  {
    name: 'Amount:',
    hash: '00000000c964a500994da59a9248a4988248a4809349a89a9142249893622492',
    aspect: 4.89,
  },
  {
    name: 'Confirm',
    hash: '000000000000000008a54dd62235c95e2225c8d222250d5208a50d1200000000',
    aspect: 3.69,
  },
];

export const EXAMPLE_CU: Omit<Profile, 'url'> = {
  bank: 'example',
  words: {
    operatorId: ['Username'],
    password: ['Passcode'],
    signIn: ['Log In'],
    memberSearch: ['Find Member'],
    memberNumber: ['Member number'],
    search: ['Find'],
    transfer: ['Move Money'],
    continue: ['Next'],
    submitTransfer: ['Confirm'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  accountWording: /Share \*{4}(\d{4})-S01/,
  codeStyle: 'sent',
  // Some labels and the review's Confirm are pictures of their words, named once.
  pictures: EXAMPLE_PICTURES,
  safePictures: EXAMPLE_PICTURES.map((p) => p.name),
};

export const PROFILES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
  example: EXAMPLE_CU,
};

/**
 * Where the factory starts at each bank: the vendor's words, with what a claim cannot say set by
 * hand (how an account is worded, how codes arrive, where search results open, the pictures of
 * words). The claims a person approves go over it.
 */
const base = (p: Omit<Profile, 'url'>): Omit<Profile, 'url'> => ({
  ...GENERIC_BANK,
  bank: p.bank,
  accountWording: p.accountWording,
  codeStyle: p.codeStyle,
  pictures: p.pictures,
  safePictures: p.safePictures,
});

export const BASES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
  example: base(EXAMPLE_CU),
};

/**
 * A profile from approved claims over the profile they start from: the bank's base for a bank the
 * factory onboards, the bank's last profile for a repair (plan, §7). A claimed word replaces the
 * base's (two claims for one word are synonyms), and so does a claimed refusal, statements notice
 * or screen's words. The rest is the base's, and the hazard check is what proves it holds.
 */
export function profileFrom<P extends Omit<Profile, 'url'>>(
  base: P,
  claims: readonly { about: string; value: string }[],
): P {
  const words = { ...base.words };
  const claimed = new Set<string>();
  const refusals = new Map(base.refusals.map((r) => [r.code, r.text]));
  const screens = { ...base.screens };
  for (const c of claims) {
    const [part, ...rest] = c.about.split('.');
    const name = rest.join('.');
    if (part === 'words' && Object.hasOwn(words, name)) {
      const w = name as keyof typeof words;
      words[w] = claimed.has(w) ? [...words[w], c.value] : [c.value];
      claimed.add(w);
    } else if (part === 'refusals' && name) refusals.set(name as ResultCode, c.value);
    else if (part === 'screens' && name) screens[name] = c.value;
  }
  return {
    ...base,
    words,
    refusals: [...refusals].map(([code, text]) => ({ text, code })),
    screens,
  };
}
