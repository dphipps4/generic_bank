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
    transfer: ['Transfer Funds'],
    continue: ['Continue'],
    submitTransfer: ['Submit transfer'],
    statements: ['Statements'],
    statement: ['Statement'],
  },
  refusals: [
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
  ],
  statementsKept: 'Only the last 12 months of statements are available online.',
  accountWording: /Account ending in (\d{4})/,
  codeStyle: 'sent',
  pictures: [],
  safePictures: [],
};

export const PROFILES: Record<string, Omit<Profile, 'url'>> = { generic: GENERIC_BANK };
