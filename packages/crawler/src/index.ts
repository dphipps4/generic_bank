import { bank1 } from './bank1.js';
import type { Table } from './table.js';

export { bank1 };
/** Each bank's table, by its id: a bank with none has no crawler. */
export const TABLES: Readonly<Record<string, Table>> = { generic: bank1 };
export {
  accountsIn,
  type Action,
  actionOf,
  cents,
  checkBalance,
  chosenIn,
  crawl,
  type Ended,
  inHistory,
  isAccount,
  leaf,
  leaves,
  namesIn,
  pagesOf,
  prepareTransfer,
  readReview,
  type Review,
  routeActions,
  seen,
  type Seen,
  type Session,
  Stop,
  submitTransfer,
  type Task,
} from './crawl.js';
export {
  type Answer,
  type At,
  type Goal,
  readOf,
  type Row,
  type Step,
  type Table,
  type Trouble,
} from './table.js';
