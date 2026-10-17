// Bank profiles for CoreLink Branch Console, each written by hand. The factory starts from a bank's
// base below and writes its own over it. The console's address comes from the registry at run time.
import type { ResultCode } from '@gb/contracts';
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

/** The profiles written by hand: bank 1's alone. Bank 2 is the factory's to learn. */
export const PROFILES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
};

/**
 * Where the factory starts at each bank: the product's own words, bank 1's, and nothing written by
 * hand about the bank itself. The claims a person approves go over it.
 */
export const BASES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
  example: { ...GENERIC_BANK, bank: 'example' },
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
