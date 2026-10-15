// Bank profiles for CoreLink Branch Console. Generic Bank's is written by hand; the factory writes
// the others. The console's address comes from the registry at run time.
import type { Profile } from '../sdk.js';

export const GENERIC_BANK: Omit<Profile, 'url'> = {
  bank: 'generic',
  words: {
    operatorId: ['Operator ID'],
    password: ['Password'],
    signIn: ['Sign In'],
    memberSearch: ['Member Search'],
    memberNumber: ['Member number'],
    search: ['Search'],
  },
  accountWording: /Account ending in (\d{4})/,
  codeStyle: 'sent',
  pictures: [],
  safePictures: [],
};

export const PROFILES: Record<string, Omit<Profile, 'url'>> = { generic: GENERIC_BANK };
