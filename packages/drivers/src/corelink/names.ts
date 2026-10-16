// The bank's own names for the controls the allowlists name (plan, §A.5). The lists say "Sign In";
// a bank draws "Log In". The guard reads the visible name and asks the list through these. They
// come from the reviewed profile, and no name here can let a control the lists never allow
// through: those are refused first, whatever a bank calls them.
import type { Profile } from '../sdk.js';
import { MORE } from './download-statements.js';
import { MENU } from './session.js';

export function controlNames(p: Pick<Profile, 'words'>): Record<string, (string | RegExp)[]> {
  const w = p.words;
  return {
    'Operator ID': w.operatorId,
    Password: w.password,
    'Sign In': w.signIn,
    'Not now': w.dismiss,
    // A drop-down menu is known by the arrow after its title, whatever the title says.
    Menu: [...w.menu, MENU],
    'Member Search': w.memberSearch,
    'Member number': w.memberNumber,
    Search: w.search,
    'Matching member': ['Open'],
    'Transfer Funds': w.transfer,
    Activity: w.activity,
    Continue: w.continue,
    'Submit transfer': w.submitTransfer,
    Statements: w.statements,
    Statement: w.statement,
    'View more': [MORE],
  };
}
