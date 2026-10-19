// Bank 1, as its evidence shows it (docs/evidence/bank-1). Every entry cites its frame; nothing
// here was read from the bank's code.
import type { Table } from './table.js';

export const bank1: Table = {
  bank: 'generic',
  home: 'console',
  rows: [
    {
      page: 'sign-in',
      screen: 'sign_in',
      shows: ['Operator ID:', 'Password:'],
      never: ['Welcome back'],
      do: {
        any: [
          { type: 'Operator ID', value: '$operator' },
          { type: 'Password', value: '$password' },
          { press: 'Sign In' },
        ],
      },
      frame: 'happy/01',
    },
    {
      // A workstation the bank remembers: the operator is known, and no code is asked for.
      page: 'welcome back',
      screen: 'sign_in',
      shows: ['Welcome back', 'Password:'],
      do: {
        any: [{ type: 'Password', value: '$password' }, { press: 'Sign In' }],
      },
      frame: 'trusted/09',
    },
    {
      page: 'code chooser',
      screen: 'staff_code',
      shows: ['Where should we send your code?'],
      do: { any: [{ press: 'Send code' }] },
      frame: 'happy/04',
    },
    {
      page: 'code',
      screen: 'staff_code',
      shows: ['Enter the 6-digit code we sent'],
      never: ['That code has expired.'],
      do: {
        any: [{ type: 'Code', value: '$code' }, { press: 'Verify' }],
      },
      frame: 'happy/05',
    },
    {
      // A code typed after its seven minutes: a fresh one is sent, and the code page runs again.
      page: 'code expired',
      screen: 'staff_code',
      shows: ['That code has expired.'],
      do: { any: [{ press: 'Send a new code' }] },
      frame: 'code-expired/01',
    },
    {
      page: 'home',
      shows: ['Use Member Search to begin.'],
      do: { any: [{ press: 'Member Search' }] },
      frame: 'happy/07',
    },
    {
      page: 'promo',
      shows: ['New in CoreLink'],
      do: { any: [{ press: 'Member Search' }] },
      frame: 'hazard-promo/07',
    },
    {
      page: 'member search',
      screen: 'member.search',
      shows: ['Member number:'],
      never: ['Status'],
      do: {
        any: [{ type: 'Member number', value: '$member' }, { press: 'Search' }],
      },
      frame: 'happy/08',
    },
    {
      page: 'member found',
      screen: 'member.search',
      shows: ['Member number:', 'Status'],
      do: { any: [{ press: 'Open' }] },
      frame: 'happy/10',
    },
    {
      page: 'summary',
      screen: 'member.summary',
      shows: ['Member Summary', 'Available balance:'],
      do: {
        transfer: [{ press: 'Transfer Funds', near: 'Member Summary' }],
        history: [{ press: 'Activity', near: '$from' }],
      },
      frame: 'happy/11',
    },
    {
      page: 'transfer form',
      screen: 'transfer.form',
      shows: ['From:', 'Amount:', 'Continue'],
      never: ['Review transfer', 'Transfer posted'],
      do: {
        transfer: [
          { choose: 'From', containing: '$from' },
          { choose: 'To', containing: '$to' },
          { type: 'Amount', value: '$amount' },
          { type: 'Memo', value: '$memo' },
          { press: 'Continue' },
        ],
      },
      frame: 'transfer/12',
    },
    {
      page: 'review',
      screen: 'transfer.review',
      shows: ['Review transfer'],
      do: {},
      frame: 'transfer/17',
    },
    {
      page: 'posted',
      screen: 'transfer.posted',
      shows: ['Transfer posted'],
      do: {},
      frame: 'transfer/18',
    },
    { page: 'activity', shows: ['Activity:', 'Description'], do: {}, frame: 'transfer/20' },
  ],
  names: { 'Matching member': ['Open'] },
  ends: { balance: 'summary', transfer: 'review', history: 'activity' },
  answers: [
    {
      says: 'No member found with that number',
      code: 'no_such_member',
      frame: 'no-such-member/10',
    },
    { says: 'Member status: Closed', code: 'member_closed', frame: 'closed-member/11' },
    {
      says: 'more than the available balance',
      code: 'insufficient_funds',
      frame: 'insufficient-funds/16',
    },
    { says: 'Enter an amount between', code: 'invalid_amount', frame: 'invalid-amount/16' },
    {
      says: 'Transfers from this account type are not permitted',
      code: 'permission_denied',
      frame: 'not-permitted/16',
    },
    { says: 'This account is restricted', code: 'account_restricted', frame: 'restricted/16' },
    { says: 'cannot transfer more than', code: 'limit_exceeded', frame: 'over-limit/16' },
    {
      says: 'You do not have permission to view this member',
      code: 'permission_denied',
      frame: 'hazard-permission-denial/11',
    },
    {
      says: 'record is in use by another operator',
      code: 'record_in_use',
      retryable: true,
      frame: 'hazard-record-in-use/11',
    },
  ],
  trouble: [
    {
      says: 'temporarily unable to service your request',
      code: 'unavailable',
      again: 2,
      frame: 'hazard-service-unavailable/02',
    },
    {
      says: 'An unexpected error has occurred',
      code: 'app_error',
      again: 2,
      frame: 'hazard-js-error-fatal/09',
    },
    {
      says: 'Available balance: --',
      code: 'app_error',
      again: 1,
      frame: 'hazard-js-error-widget/11',
    },
  ],
  submit: { press: 'Submit transfer', frame: 'transfer/17' },
  reads: {
    // A tile of the summary (happy/11).
    balance:
      '{name} Account ending in {last4} Available balance: {available} Current balance: {current}',
    // The review's cells (transfer/17), and the posted page's line (transfer/18).
    review: 'From:\n{from}\nTo:\n{to}\nAmount:\n{amount}\nMemo:\n{memo}',
    confirmation: 'Transfer posted. Confirmation number {confirmation}.',
    // The results row (happy/10), then the summary's heading (happy/11).
    name: ['$member\n{name}\n{status}', 'Member $member · {name}'],
  },
};
