// Guardrails (plan, Appendix J): every layer that stands between the crawler and an action it was
// not given. They import nothing from the Runner, the drivers or the factory, so nothing they guard
// can reach in and change a verdict.
export {
  ALLOWLISTS,
  ANY,
  type Context,
  decide,
  type Entry,
  GuardError,
  JOBS,
  type Layer,
  MONEY_SCREENS,
  MONEY_WORDS,
  type Names,
  NEVER,
  type Verb,
  VERBS,
  type Verdict,
} from './allowlist.js';
export {
  consumeGrant,
  GRANT_LIFETIME_MS,
  type GrantCheck,
  type GrantRefusal,
  issueGrant,
  type Sql,
  type TransferValues,
} from './grants.js';
export { type Trip, type Tripped, tripGuard } from './trip.js';
