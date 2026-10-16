// CoreLink Branch Console's screens, as signatures built from a bank's profile. Outcome and error
// screens are signatures too: that is how the bank's answers are read.
import type { Signature } from '@gb/screen';
import type { Profile } from '../sdk.js';

const ERRORS_ON_SEARCH = [
  'No member found',
  'Member status: Closed',
  'record is in use by another operator',
  'Enter an 8-digit member number',
];

export function signatures(p: Profile): Signature[] {
  const w = p.words;
  const marks = p.screens ?? {};
  // A notice after sign-in, at a bank that shows one: its words, and the button that passes it.
  const notice: Signature[] =
    marks['login.notice'] && w.dismiss.length
      ? [{ id: 'login.notice', requires: [marks['login.notice']], controls: [{ name: w.dismiss }] }]
      : [];
  return [
    ...notice,
    {
      id: 'login.signin',
      requires: [w.operatorId],
      controls: [{ role: 'password' }],
      forbids: ['Welcome back', 'do not match', 'is locked', 'session has ended'],
    },
    {
      id: 'login.welcome_back',
      requires: ['Welcome back'],
      controls: [{ role: 'password' }],
      forbids: ['do not match', 'is locked'],
    },
    {
      id: 'login.session_ended',
      requires: ['Your session has ended'],
      controls: [{ role: 'password' }],
    },
    { id: 'login.bad_credentials', requires: ['do not match'] },
    { id: 'login.locked', requires: ['This operator is locked'] },
    { id: 'login.code_choose', requires: ['Where should we send your code?'] },
    {
      id: 'login.code_enter',
      requires: [
        ['Enter the 6-digit code we sent', 'Enter the 6-digit code from your authenticator app'],
      ],
      forbids: ['That code is not correct', 'That code has expired'],
    },
    { id: 'login.code_wrong', requires: ['That code is not correct'] },
    { id: 'login.code_expired', requires: ['That code has expired'] },
    { id: 'login.terms', requires: ['Terms updated'], controls: [{ name: 'Acknowledge' }] },
    { id: 'dialog.promo', requires: ['New in CoreLink'], controls: [{ name: 'Not now' }] },
    // The way to member search may sit in a closed drop-down menu, so the home page is known by its
    // words; a redesign's menu, where there is one, is its control.
    {
      id: 'console.home',
      requires: [marks['console.home'] ?? 'to begin'],
      ...(w.menu.length ? { controls: [{ name: w.menu }] } : {}),
    },
    {
      id: 'member.search',
      controls: [{ name: w.search }],
      requires: [w.memberNumber],
      forbids: [...ERRORS_ON_SEARCH, 'to begin'],
    },
    { id: 'member.no_such_member', requires: ['No member found with that number'] },
    { id: 'member.closed', requires: ['Member status: Closed'] },
    { id: 'member.in_use', requires: ['record is in use by another operator'] },
    { id: 'member.permission', requires: ['You do not have permission'] },
    {
      id: 'member.summary',
      requires: ['Available balance'],
      controls: [{ name: w.activity }],
    },
    {
      // The whole form, or one of its pages where a bank splits it: the amount, or the accounts.
      id: 'transfer.form',
      requires: [w.transfer, ['Amount', 'From']],
      controls: [{ name: w.continue }],
      forbids: ['Review transfer'],
    },
    {
      id: 'transfer.review',
      requires: ['Review transfer', 'Amount'],
      controls: [{ name: w.submitTransfer }],
    },
    {
      id: 'transfer.supervisor',
      requires: ['Supervisor approval required', 'Approval code'],
      controls: [{ name: 'Approve' }],
    },
    { id: 'transfer.posted', requires: ['Transfer posted', 'Confirmation number'] },
    // A row's way to its statement may be a button on it, or sit in the row's drop-down menu.
    {
      id: 'statements',
      requires: ['Statement Date', 'Document Type'],
      forbids: ['Available balance'],
    },
    // A statement shown as a page of its own, with its own download.
    {
      id: 'statement.viewer',
      requires: ['Opening balance', 'Closing balance'],
      controls: [{ name: 'Download' }],
    },
    { id: 'error.unavailable', requires: ['Service Unavailable'] },
    { id: 'error.fatal', requires: ['An unexpected error has occurred'] },
  ];
}
