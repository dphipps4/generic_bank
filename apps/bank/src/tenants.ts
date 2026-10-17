// The two banks: one product, two configurations. Every difference between them lives here:
// brand, labels, theme, URL base path, account wording, thresholds, code channels and the seed
// that fixes each page's markup dialect. The bank shares no code with the automation that
// drives it.

export type TenantId = 'generic' | 'example';
export type Theme = 'y2003' | 'teal';
export type CodeChannel = 'text' | 'email';
/** The console's shape: a nav frame on the left (bank 1), or a tab strip across the top (bank 2). */
export type Layout = 'nav' | 'tabs';
/** What a bank serves from its second origin (another port): bank 2's tab strip. */
export type SecondOrigin = 'tabs';

export interface Labels {
  operatorId: string;
  password: string;
  signIn: string;
  memberSearch: string;
  memberNumber: string;
  search: string;
  transferFunds: string;
  continue: string;
  submitTransfer: string;
  statements: string;
  activity: string;
}

/** The places BANK_REDESIGN renames. */
export type Renamed = Pick<Labels, 'memberSearch' | 'transferFunds' | 'statements' | 'activity'>;

/** Words this bank shows only as pixels: some labels and some buttons. */
export interface ImageText {
  labels?: string[];
  buttons?: string[];
}

export interface Tenant {
  id: TenantId;
  brand: string;
  version: string;
  basePath: string;
  branch: string;
  theme: Theme;
  layout: Layout;
  secondOrigin?: SecondOrigin;
  labels: Labels;
  /** How an account is named on screen, from its full number. */
  accountWording: (number: string) => string;
  /** Transfers above this many cents need a supervisor's approval code. */
  supervisorThresholdCents: number;
  codeChannels: CodeChannel[];
  imageText?: ImageText;
  /** Turns away anything not shaped like a browser with "403 Access denied" (bank 2). */
  botScreen?: boolean;
  /** Fixes every page's markup dialect, so a tenant's UI is the same from run to run. */
  markupSeed: number;
  /** The database the bank keeps its ledger in. */
  database: string;
  /** The vendor's redesign (BANK_REDESIGN=1) renames these places, in the bank's own voice. */
  redesign: Renamed;
  /**
   * The redesign is on: an interstitial after sign-in, the new names, and the nav moved into a
   * Menu at the top right of a console laid out anew. Set only by `redesigned`.
   */
  redesigned?: boolean;
}

const last4 = (n: string) => n.slice(-4);

export const TENANTS: Record<TenantId, Tenant> = {
  generic: {
    id: 'generic',
    brand: 'Generic Bank',
    version: '4.2',
    basePath: '/corelink/',
    branch: 'Main Street Branch',
    theme: 'y2003',
    layout: 'nav',
    labels: {
      operatorId: 'Operator ID',
      password: 'Password',
      signIn: 'Sign In',
      memberSearch: 'Member Search',
      memberNumber: 'Member number',
      search: 'Search',
      transferFunds: 'Transfer Funds',
      continue: 'Continue',
      submitTransfer: 'Submit transfer',
      statements: 'Statements',
      activity: 'Activity',
    },
    accountWording: (n) => `Account ending in ${last4(n)}`,
    supervisorThresholdCents: 250_000,
    codeChannels: ['text', 'email'],
    markupSeed: 2003,
    database: 'bank_generic',
    redesign: {
      memberSearch: 'Member Lookup',
      transferFunds: 'Move Money',
      statements: 'Documents',
      activity: 'History',
    },
  },
  example: {
    id: 'example',
    brand: 'Example Credit Union',
    version: '4.3',
    basePath: '/',
    branch: 'Riverside Office',
    theme: 'teal',
    layout: 'tabs',
    secondOrigin: 'tabs',
    labels: {
      operatorId: 'Username',
      password: 'Passcode',
      signIn: 'Log In',
      memberSearch: 'Find Member',
      memberNumber: 'Member number',
      search: 'Find',
      transferFunds: 'Move Money',
      continue: 'Next',
      submitTransfer: 'Confirm',
      statements: 'Statements',
      activity: 'Activity',
    },
    accountWording: (n) => `Share ****${last4(n)}-S01`,
    supervisorThresholdCents: 100_000,
    codeChannels: ['email'],
    imageText: {
      labels: ['Username', 'Passcode', 'Member number', 'Amount'],
      buttons: ['Confirm'],
    },
    botScreen: true,
    markupSeed: 4301,
    database: 'bank_example',
    redesign: {
      memberSearch: 'Look Up a Member',
      transferFunds: 'Transfers',
      statements: 'eDocs',
      activity: 'Transactions',
    },
  },
};

/**
 * The bank after its vendor's redesign (BANK_REDESIGN=1): the same ledger, members, codes,
 * transfers and refusals, in new words and a new layout. The look changes, never the meaning.
 */
export const redesigned = (t: Tenant): Tenant => ({
  ...t,
  labels: { ...t.labels, ...t.redesign },
  redesigned: true,
});
