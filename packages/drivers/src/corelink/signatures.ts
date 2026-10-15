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
  return [
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
    { id: 'console.home', requires: ['to begin'], controls: [{ name: w.memberSearch }] },
    {
      id: 'member.search',
      controls: [{ name: w.search }],
      requires: [w.memberNumber],
      forbids: ERRORS_ON_SEARCH,
    },
    { id: 'member.no_such_member', requires: ['No member found with that number'] },
    { id: 'member.closed', requires: ['Member status: Closed'] },
    { id: 'member.in_use', requires: ['record is in use by another operator'] },
    { id: 'member.permission', requires: ['You do not have permission'] },
    { id: 'member.summary', requires: ['Available balance'], controls: [{ name: 'Activity' }] },
    { id: 'error.unavailable', requires: ['Service Unavailable'] },
    { id: 'error.fatal', requires: ['An unexpected error has occurred'] },
  ];
}
