import argon2 from 'argon2';
import type { Db } from './db.js';
import { hash32, rng } from './rng.js';
import type { Tenant } from './tenants.js';

// Hashing is tuned for a container with little memory: about 19 MB per hash.
export const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface SeedSecrets {
  servicePassword: string;
  supervisorPassword: string;
}

/** The staff accounts every bank starts with. */
export const OPERATORS = {
  service: { id: '0412', name: 'Operator 0412', role: 'senior teller', limit: 1_000_000 },
  supervisor: { id: '0901', name: 'Supervisor 0901', role: 'supervisor', limit: 5_000_000 },
  locked: { id: '0388', name: 'Operator 0388', role: 'teller', limit: 300_000 },
} as const;

/** Members with a known story. Everyone else is ordinary. */
export const MEMBERS = {
  demo: '40017732', // healthy checking, savings and money market
  ira: '40021145', // checking and an IRA: transfers out of the IRA are refused
  cd: '40023318', // checking and a CD: transfers out of the CD are refused
  nearZero: '40025561', // checking with $3.17 available
  restricted: '40027794', // a savings account marked "refer to branch"
  closed: '40029907', // member status: closed
  wealthy: '40031120', // large balances, for supervisor approval and the daily limit
  missing: '40099999', // never seeded: "No member found"
} as const;

const SURNAMES = [
  'Sample',
  'Example',
  'Placeholder',
  'Fixture',
  'Testcase',
  'Specimen',
  'Prototype',
  'Template',
  'Mockup',
  'Standin',
  'Facsimile',
  'Replica',
  'Dummy',
  'Draft',
  'Pattern',
  'Widget',
  'Gadget',
  'Lorem',
  'Ipsum',
  'Dolor',
  'Sitamet',
  'Proxy',
  'Surrogate',
  'Model',
  'Exemplar',
];
const FIRST = [
  'Alex',
  'Blair',
  'Casey',
  'Dana',
  'Emery',
  'Finley',
  'Gray',
  'Harper',
  'Indigo',
  'Jordan',
  'Kai',
  'Logan',
  'Morgan',
  'Noel',
  'Oakley',
  'Parker',
  'Quinn',
  'Riley',
  'Sage',
  'Taylor',
];
const PURCHASES = [
  'POS PURCHASE CORNER GROCERY',
  'POS PURCHASE CITY FUEL',
  'POS PURCHASE MAIN ST PHARMACY',
  'POS PURCHASE HARDWARE BARN',
  'POS PURCHASE BOOK NOOK',
  'POS PURCHASE DINER 24',
  'ATM WITHDRAWAL BRANCH 004',
  'ONLINE PURCHASE GENERIC MARKET',
  'UTILITY PAYMENT CITY WATER',
];

type AccountSpec = {
  type: 'checking' | 'savings' | 'money market' | 'ira' | 'cd';
  nickname: string;
  openingCents: number;
  restriction?: 'refer to branch';
};

function accountsFor(number: string, r: ReturnType<typeof rng>): AccountSpec[] {
  const checking = (c: number): AccountSpec => ({
    type: 'checking',
    nickname: 'Everyday Checking',
    openingCents: c,
  });
  const savings = (c: number): AccountSpec => ({
    type: 'savings',
    nickname: 'Rainy Day Savings',
    openingCents: c,
  });
  switch (number) {
    case MEMBERS.demo:
      return [
        checking(480_000),
        savings(1_200_000),
        { type: 'money market', nickname: 'Money Market', openingCents: 2_500_000 },
      ];
    case MEMBERS.ira:
      return [
        checking(260_000),
        { type: 'ira', nickname: 'Traditional IRA', openingCents: 4_100_000 },
      ];
    case MEMBERS.cd:
      return [checking(150_000), { type: 'cd', nickname: '12-Month CD', openingCents: 1_000_000 }];
    case MEMBERS.nearZero:
      return [checking(317), savings(4_000)];
    case MEMBERS.restricted:
      return [checking(90_000), { ...savings(640_000), restriction: 'refer to branch' }];
    case MEMBERS.wealthy:
      return [
        checking(5_200_000),
        savings(9_800_000),
        { type: 'money market', nickname: 'Money Market', openingCents: 15_000_000 },
      ];
    default: {
      const list = [checking(r.int(40_000, 900_000))];
      if (r.chance(0.8)) list.push(savings(r.int(50_000, 3_000_000)));
      if (r.chance(0.3))
        list.push({
          type: 'money market',
          nickname: 'Money Market',
          openingCents: r.int(500_000, 6_000_000),
        });
      return list;
    }
  }
}

/** Seeds the bank once. Running it again on a seeded database changes nothing. */
export async function seed(db: Db, t: Tenant, secrets: SeedSecrets, now: Date): Promise<boolean> {
  const done = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM members');
  if ((done.rows[0]?.n ?? 0) > 0) return false;

  const r = rng(hash32('seed', t.id));
  for (const [key, o] of Object.entries(OPERATORS)) {
    const pw = key === 'supervisor' ? secrets.supervisorPassword : secrets.servicePassword;
    const ins = await db.query<{ pk: number }>(
      `INSERT INTO operators (operator_id, display_name, role, locked, phone, email, daily_limit_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING pk`,
      [
        o.id,
        o.name,
        o.role,
        key === 'locked',
        `+1 555 01${o.id}`,
        `op${o.id}@${t.id}.bank.localhost`,
        o.limit,
      ],
    );
    await db.query('INSERT INTO credentials (operator_pk, hash) VALUES ($1, $2)', [
      ins.rows[0]!.pk,
      await argon2.hash(pw, ARGON),
    ]);
  }

  // The bank's own side of every transaction, so the ledger always balances to zero.
  const suspense = await db.query<{ id: number }>(
    `INSERT INTO accounts (member_number, type, nickname, number) VALUES (NULL, 'suspense', 'Bank suspense', '0000000000') RETURNING id`,
  );
  const suspenseId = suspense.rows[0]!.id;

  const special = Object.values(MEMBERS).filter((m) => m !== MEMBERS.missing);
  const numbers: string[] = [...special];
  while (numbers.length < 25) {
    const n = String(40_000_000 + r.int(32_000, 98_000));
    if (!numbers.includes(n)) numbers.push(n);
  }

  const entries: unknown[][] = [];
  let txn = 0;
  const post = (
    accountId: number,
    cents: number,
    description: string,
    at: Date,
    pending = false,
  ) => {
    const id = `T${t.id.slice(0, 2).toUpperCase()}${String(++txn).padStart(7, '0')}`;
    entries.push([id, accountId, cents, pending, description, at]);
    entries.push([id, suspenseId, -cents, pending, description, at]);
  };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1, 9));

  for (const [i, number] of numbers.entries()) {
    const first = number === MEMBERS.demo ? 'Alex' : (FIRST[i % FIRST.length] as string);
    const last = number === MEMBERS.demo ? 'Sample' : (SURNAMES[i % SURNAMES.length] as string);
    const status = number === MEMBERS.closed ? 'closed' : 'active';
    await db.query(
      'INSERT INTO members (number, first_name, last_name, status) VALUES ($1, $2, $3, $4)',
      [number, first, last, status],
    );
    for (const spec of accountsFor(number, r)) {
      const acctNumber = String(1_000_000_000 + r.int(0, 899_999_999));
      const a = await db.query<{ id: number }>(
        `INSERT INTO accounts (member_number, type, nickname, number, restriction) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [number, spec.type, spec.nickname, acctNumber, spec.restriction ?? null],
      );
      const id = a.rows[0]!.id;
      post(id, spec.openingCents, 'OPENING BALANCE', start);
      // Near-zero and closed members keep a quiet history; everyone else lives a little.
      if (number === MEMBERS.nearZero || number === MEMBERS.closed) continue;
      for (let m = 0; m < 12; m++) {
        const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1, 9));
        const day = (d: number) =>
          new Date(month.getTime() + (d - 1) * 86_400_000 + r.int(0, 8) * 3_600_000);
        if (spec.type === 'checking') {
          const pay = r.int(180_000, 320_000);
          post(id, pay, 'PAYROLL DEPOSIT ACME CORP', day(1));
          post(id, pay, 'PAYROLL DEPOSIT ACME CORP', day(15));
          for (let k = r.int(4, 8); k > 0; k--)
            post(id, -r.int(800, 18_000), r.pick(PURCHASES), day(r.int(2, 27)));
          post(id, -r.int(90_000, 160_000), 'RENT PAYMENT ONLINE', day(3));
        } else {
          post(id, Math.round(spec.openingCents * 0.0004), 'INTEREST PAID', day(28));
        }
      }
      if (spec.type === 'checking')
        post(id, -r.int(1_500, 9_000), 'POS PURCHASE CORNER GROCERY', now, true);
    }
  }

  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    const values = chunk.map(
      (_, j) =>
        `($${j * 6 + 1}, $${j * 6 + 2}, $${j * 6 + 3}, $${j * 6 + 4}, $${j * 6 + 5}, $${j * 6 + 6})`,
    );
    await db.query(
      `INSERT INTO ledger_entries (txn, account_id, amount_cents, pending, description, posted_at) VALUES ${values.join(',')}`,
      chunk.flat(),
    );
  }
  return true;
}
