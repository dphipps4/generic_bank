import { describe, expect, it } from 'vitest';
import type { Control, ScreenModel, Text } from '../src/model.js';
import { normalize, reading, recognize, type Signature } from '../src/recognize.js';

const box = (y: number, x = 0) => ({ x, y, w: 50, h: 10 });
const text = (t: string, y: number, x = 0): Text => ({ text: t, box: box(y, x), frame: 'top' });
const control = (role: Control['role'], name: string, y: number): Control => ({
  ref: 'c',
  role,
  name,
  box: box(y),
  enabled: true,
  frame: 'top',
  backendNodeId: 1,
  session: 's',
});
const model = (
  texts: Text[],
  controls: Control[],
  url = 'http://bank/corelink/x',
): ScreenModel => ({
  url,
  title: '',
  frames: [],
  texts,
  controls,
  structureKey: '',
  screenshot: Buffer.alloc(0),
  dropped: 0,
  animated: [],
});

const SIGS: Signature[] = [
  {
    id: 'login.signin',
    requires: [['Operator ID', 'Staff number']],
    controls: [{ role: 'password' }],
    forbids: ['Welcome back'],
  },
  { id: 'login.welcome_back', requires: ['Welcome back'], controls: [{ role: 'password' }] },
  {
    id: 'transfer.review',
    requires: ['Review transfer'],
    controls: [{ name: ['Submit transfer', 'Confirm'] }],
    forbids: ['Transfer posted'],
  },
  { id: 'transfer.posted', requires: ['Transfer posted'] },
  { id: 'error.no_member', requires: ['No member found with that number'] },
];

describe('recognizing screens', () => {
  it('reads a label split across two cells as one phrase', () => {
    const m = model([text('Staff', 10, 0), text('number:', 10, 60)], [control('password', '', 30)]);
    expect(reading(m)).toContain('staff number');
    expect(recognize(m, SIGS).screen).toBe('login.signin');
  });

  it('tells two layouts of one screen apart by what each must not show', () => {
    const m = model([text('Welcome back, teller0412', 5)], [control('password', '', 30)]);
    expect(recognize(m, SIGS).screen).toBe('login.welcome_back');
  });

  it('needs the named control, by any of its names', () => {
    const m = model([text('Review transfer', 5)], [control('image-button', 'Confirm', 40)]);
    expect(recognize(m, SIGS).screen).toBe('transfer.review');
    const noButton = model([text('Review transfer', 5)], []);
    const r = recognize(noButton, SIGS);
    expect(r.screen).toBeNull();
    expect(r.closest[0]).toEqual({
      id: 'transfer.review',
      missing: ['a control named "submit transfer" or "confirm"'],
    });
  });

  it('puts first the screen whose checks the page mostly meets, not one it fails outright', () => {
    const sigs = [
      { id: 'login.error', requires: ['do not match'] },
      {
        id: 'console.home',
        requires: ['to begin', 'Branch Console'],
        controls: [{ name: 'Menu' }],
      },
    ];
    const m = model([text('Use Member Inquiry to begin.', 5)], [control('link', 'Menu', 20)]);
    expect(recognize(m, sigs).closest.map((c) => c.id)).toEqual(['console.home', 'login.error']);
    // What a screen must not show doesn't make it closer.
    const withSearch = [
      ...sigs,
      {
        id: 'member.search',
        requires: ['Member'],
        controls: [{ name: 'Inquire' }],
        forbids: ['to begin', 'No member', 'closed', 'locked'],
      },
    ];
    expect(recognize(m, withSearch).closest[0]!.id).toBe('console.home');
  });

  it('reads business outcomes as screens', () => {
    expect(recognize(model([text('No member found with that number.', 5)], []), SIGS).screen).toBe(
      'error.no_member',
    );
  });

  it('calls a screen unknown when nothing matches, and never guesses', () => {
    const r = recognize(
      model([text('System maintenance: please verify your mailing address to continue.', 5)], []),
      SIGS,
    );
    expect(r.screen).toBeNull();
    expect(r.matched).toEqual([]);
  });

  it('calls a screen unknown when two signatures match, unless a path hint settles it', () => {
    const both: Signature[] = [
      { id: 'a', requires: ['Statements'], pathHint: /\/statements/ },
      { id: 'b', requires: ['Statements'] },
    ];
    expect(recognize(model([text('Statements', 5)], [], 'http://bank/x/home'), both)).toMatchObject(
      { screen: null, matched: ['a', 'b'] },
    );
    expect(
      recognize(model([text('Statements', 5)], [], 'http://bank/x/statements'), both).screen,
    ).toBe('a');
  });

  it('normalizes the way a person reads', () => {
    expect(normalize('  Operator   ID:  ')).toBe('operator id');
    expect(normalize('Member’s record')).toBe("member's record");
  });
});
