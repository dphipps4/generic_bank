// The four banks: one product, four configurations. Every difference between them lives here:
// brand, labels, theme, URL base path, account wording, thresholds, code style and the seed
// that fixes each page's markup dialect. The bank shares no code with the automation that
// drives it.

export type TenantId = 'generic' | 'example' | 'sample' | 'placeholder';
export type Theme = 'y2003' | 'teal' | 'maroon' | 'flat';
export type CodeChannel = 'text' | 'email';
/**
 * The console's shape: a nav frame on the left (bank 1), a tab strip across the top (bank 2), the
 * tab strip plus a notices frame on the right (bank 3), or no frameset at all, a drop-down menu
 * bar over an inline frame (bank 4).
 */
export type Layout = 'nav' | 'tabs' | 'tabs-notices' | 'menubar';
/** What a bank serves from its second origin (another port): bank 2's tab strip, bank 4's sign-in. */
export type SecondOrigin = 'tabs' | 'signin';

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
}

/**
 * Failure modes that only some banks show, so crawling them teaches the factory something new.
 * Bank 3's six, then bank 4's six (plan, Appendix C.4).
 */
export type Trouble =
  | 'hidden-duplicate'
  | 'keypress-only'
  | 'documents-among-statements'
  | 'view-more'
  | 'detached-menu'
  | 'covering-bar'
  | 'handoff-bounce'
  | 'silent-code-clear'
  | 'html-statement-viewer'
  | 'window-token'
  | 'shuffled-tiles'
  | 'false-notice';

/** Words this bank shows only as pixels: some labels, some buttons, or every section heading. */
export interface ImageText {
  labels?: string[];
  buttons?: string[];
  headings?: boolean;
}

export const has = (t: { trouble?: Trouble[] }, x: Trouble) => !!t.trouble?.includes(x);

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
  /** Member lookup also by last name (bank 3). */
  searchByName?: boolean;
  /** A "Terms updated: Acknowledge" page after every sign-in (bank 3). */
  termsAfterSignIn?: boolean;
  trouble?: Trouble[];
  /** Fixes every page's markup dialect, so a tenant's UI is the same from run to run. */
  markupSeed: number;
  /** The database the bank keeps its ledger in. */
  database: string;
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
    },
    accountWording: (n) => `Account ending in ${last4(n)}`,
    supervisorThresholdCents: 250_000,
    codeChannels: ['text', 'email'],
    markupSeed: 2003,
    database: 'bank_generic',
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
    },
    accountWording: (n) => `Share ****${last4(n)}-S01`,
    supervisorThresholdCents: 100_000,
    codeChannels: ['email'],
    imageText: {
      labels: ['Username', 'Passcode', 'Member number', 'Amount'],
      buttons: ['Confirm'],
    },
    markupSeed: 4301,
    database: 'bank_example',
  },
  sample: {
    id: 'sample',
    brand: 'Sample Savings Bank',
    version: '4.3',
    basePath: '/online/branch/',
    branch: 'Harbor Branch',
    theme: 'maroon',
    layout: 'tabs-notices',
    labels: {
      operatorId: 'Staff number',
      password: 'PIN',
      signIn: 'Enter',
      memberSearch: 'Member Inquiry',
      memberNumber: 'Member number',
      search: 'Inquire',
      transferFunds: 'Internal Transfer',
      continue: 'Proceed',
      submitTransfer: 'Post',
      statements: 'Statements',
    },
    accountWording: (n) => `Acct ${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`,
    supervisorThresholdCents: 50_000,
    codeChannels: ['text'],
    imageText: { headings: true },
    searchByName: true,
    termsAfterSignIn: true,
    trouble: [
      'hidden-duplicate',
      'keypress-only',
      'documents-among-statements',
      'view-more',
      'detached-menu',
      'covering-bar',
    ],
    markupSeed: 4302,
    database: 'bank_sample',
  },
  placeholder: {
    id: 'placeholder',
    brand: 'Placeholder Federal Credit Union',
    version: '4.4',
    basePath: '/cu/ib/',
    branch: 'Capitol Office',
    theme: 'flat',
    layout: 'menubar',
    secondOrigin: 'signin',
    labels: {
      operatorId: 'User',
      password: 'Password',
      signIn: 'Continue',
      memberSearch: 'Search',
      memberNumber: 'Member',
      search: 'Search',
      transferFunds: 'Transfer',
      continue: 'Accounts',
      submitTransfer: 'Authorize',
      statements: 'Documents',
    },
    accountWording: (n) => `··· ${last4(n)}`,
    supervisorThresholdCents: 200_000,
    codeChannels: ['text'],
    markupSeed: 4400,
    database: 'bank_placeholder',
  },
};
