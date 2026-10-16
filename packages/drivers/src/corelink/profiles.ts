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

const KEPT = 'Only the last 12 months of statements are available online.';

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
    statements: ['Statements'],
    statement: ['Statement'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  statementsKept: KEPT,
  accountWording: /Account ending in (\d{4})/,
  codeStyle: 'sent',
  searchResults: 'page',
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
    statements: ['Statements'],
    statement: ['Statement'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  statementsKept: KEPT,
  accountWording: /Share \*{4}(\d{4})-S01/,
  codeStyle: 'sent',
  searchResults: 'page',
  // Some labels and the review's Confirm are pictures of their words, named once.
  pictures: EXAMPLE_PICTURES,
  safePictures: EXAMPLE_PICTURES.map((p) => p.name),
};

const SAMPLE_HEADINGS: KnownPicture[] = [
  {
    name: 'Enter the 6-digit code we sent.',
    hash: 'aaaaaaaa9956424fadd5564f2c8dc247accdc24f2cb5d6e9cc55c24daaaaaaaa',
    aspect: 17.27,
  },
  {
    name: 'Where should we send your code?',
    hash: 'aaaaaaaa1d6929452869294328a91a423cab1a42a8ab1a42ad1929c7aaaaaaaa',
    aspect: 17.27,
  },
  {
    name: 'Terms updated',
    hash: '000000002a99252b12b96a135b797add1a592a9952e96ad50d98a68b00000000',
    aspect: 7.45,
  },
  {
    name: 'New in CoreLink',
    hash: '000000009a28abb5b22856a536195aaf16094aa736095ea59a28b2f500000000',
    aspect: 8.55,
  },
  {
    name: 'Review transfer',
    hash: '000000005928aca71348d4a9524896a95248a5297248b5299d38d4a500000000',
    aspect: 8.55,
  },
  {
    name: 'Supervisor approval required',
    hash: '000000004d72ac651531aca39535ecd32576edb777364cb5acb7245b52a54a95',
    aspect: 15.64,
  },
  {
    name: 'Transfer posted',
    hash: '00000000562a8aa75655cea95555cca956948d69529491694a735ae500000000',
    aspect: 8.55,
  },
];

export const SAMPLE_SAVINGS: Omit<Profile, 'url'> = {
  bank: 'sample',
  words: {
    operatorId: ['Staff number'],
    password: ['PIN'],
    signIn: ['Enter'],
    memberSearch: ['Member Inquiry'],
    memberNumber: ['Member number or last name'],
    search: ['Inquire'],
    transfer: ['Internal Transfer'],
    continue: ['Proceed'],
    submitTransfer: ['Post'],
    statements: ['Statements'],
    // A row's statement is in its Options menu.
    statement: ['View'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  statementsKept: KEPT,
  // "Acct 1234-5678-90": the last four digits are drawn on both sides of the last dash.
  accountWording: /Acct \d{4}-\d{2}(\d{2})-(\d{2})/,
  codeStyle: 'sent',
  searchResults: 'page',
  // Every heading is a picture of its words: those the screens are known by, named once.
  pictures: SAMPLE_HEADINGS,
  safePictures: SAMPLE_HEADINGS.map((p) => p.name),
};

export const PLACEHOLDER_FCU: Omit<Profile, 'url'> = {
  bank: 'placeholder',
  words: {
    operatorId: ['User'],
    password: ['Password'],
    signIn: ['Continue'],
    memberSearch: ['Search'],
    memberNumber: ['Member'],
    search: ['Search'],
    transfer: ['Transfer'],
    // The form is two pages: the amount, then the accounts.
    continue: ['Accounts', 'Review'],
    submitTransfer: ['Authorize'],
    statements: ['Documents'],
    statement: ['Statement'],
    activity: ['Activity'],
    menu: [],
    dismiss: [],
  },
  refusals: REFUSALS,
  statementsKept: KEPT,
  accountWording: /··· (\d{4})/,
  codeStyle: 'authenticator',
  searchResults: 'window',
  pictures: [],
  safePictures: [],
};

export const PROFILES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
  example: EXAMPLE_CU,
  sample: SAMPLE_SAVINGS,
  placeholder: PLACEHOLDER_FCU,
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
  searchResults: p.searchResults,
  pictures: p.pictures,
  safePictures: p.safePictures,
});

export const BASES: Record<string, Omit<Profile, 'url'>> = {
  generic: GENERIC_BANK,
  example: base(EXAMPLE_CU),
  sample: base(SAMPLE_SAVINGS),
  placeholder: base(PLACEHOLDER_FCU),
};

/**
 * A profile from approved claims over the profile they start from: the bank's base for a bank the
 * factory onboards, the bank's last profile for a repair (plan, §M.1). A claimed word replaces the
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
  let statementsKept = base.statementsKept;
  for (const c of claims) {
    const [part, ...rest] = c.about.split('.');
    const name = rest.join('.');
    if (part === 'words' && Object.hasOwn(words, name)) {
      const w = name as keyof typeof words;
      words[w] = claimed.has(w) ? [...words[w], c.value] : [c.value];
      claimed.add(w);
    } else if (part === 'refusals' && name) refusals.set(name as ResultCode, c.value);
    else if (part === 'screens' && name) screens[name] = c.value;
    else if (part === 'statementsKept') statementsKept = c.value;
  }
  return {
    ...base,
    words,
    refusals: [...refusals].map(([code, text]) => ({ text, code })),
    statementsKept,
    screens,
  };
}
