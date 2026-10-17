// The seeded secrets and personal values of a bank, read from the bank's own database: its members'
// numbers, names and full account numbers, its staff's contact details and passwords, and every
// staff code it has sent.
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { TENANTS } from '../../apps/bank/src/tenants.js';
import { type LiveBank, PASSWORDS } from '../support/banks.js';
import { anywhere, digits, type Needle, words } from './scan.js';

const STORY = Object.fromEntries(Object.entries(MEMBERS).map(([k, v]) => [v, k]));

export interface Seeded {
  /** Looked for in every row, object and log line. */
  text: Needle[];
  /** Also covered wherever a screen drew them: the last four digits of accounts, amounts of money. */
  drawn: Needle[];
}

/**
 * Members the runs looked up are named by their first and last names on their own too. A name that
 * is also a word of the bank's brand is looked for only as part of a full name.
 */
export async function seededOf(bank: LiveBank, lookedUp: string[]): Promise<Seeded> {
  const brand = TENANTS[bank.id].brand.split(/\s+/);
  const text: Needle[] = [];
  const drawn: Needle[] = [];

  const members = await bank.db.query<{ number: string; first: string; last: string }>(
    'SELECT number, first_name AS first, last_name AS last FROM members ORDER BY number',
  );
  const label = new Map<string, string>();
  members.rows.forEach((m, i) =>
    label.set(m.number, `${bank.id} member ${STORY[m.number] ?? `#${i + 1}`}`),
  );
  for (const m of members.rows) {
    const who = label.get(m.number)!;
    text.push(digits(`${who}'s member number`, m.number));
    for (const full of [
      `${m.first} ${m.last}`,
      `${m.last}, ${m.first}`,
      `${m.first[0]}. ${m.last}`,
    ])
      text.push(words(`${who}'s name`, full, { anyCase: true }));
    if (lookedUp.includes(m.number))
      for (const part of [m.first, m.last].filter((p) => !brand.includes(p)))
        for (const form of [part, part.toUpperCase()])
          text.push(words(`${who}'s ${part === m.first ? 'first' : 'last'} name`, form));
  }

  const accounts = await bank.db.query<{ member: string; number: string; type: string }>(
    'SELECT member_number AS member, number, type FROM accounts WHERE member_number IS NOT NULL ORDER BY id',
  );
  for (const a of accounts.rows) {
    const whose = `${label.get(a.member)}'s ${a.type} account`;
    text.push(digits(`${whose} number`, a.number));
    drawn.push(digits(`the last four digits of ${whose}`, a.number.slice(-4)));
  }

  const staff = await bank.db.query<{
    id: string;
    name: string;
    phone: string;
    email: string;
  }>('SELECT operator_id AS id, display_name AS name, phone, email FROM operators');
  for (const o of staff.rows) {
    const who = `${bank.id} operator ${o.id.replace(/\d/g, '*')}`;
    text.push(words(`${who}'s name`, o.name, { anyCase: true }));
    text.push(anywhere(`${who}'s phone`, o.phone));
    text.push(anywhere(`${who}'s email`, o.email));
  }
  text.push(anywhere('the service password', PASSWORDS.service));
  text.push(anywhere('the supervisor password', PASSWORDS.supervisor));

  const sent = await bank.db.query<{ body: string }>('SELECT body FROM messages');
  const codes = new Set(sent.rows.flatMap((m) => m.body.match(/(?<!\d)\d{6}(?!\d)/g) ?? []));
  for (const c of codes) text.push(digits(`a staff code ${bank.id} sent`, c));

  drawn.push({ what: 'an amount of money', re: /\$\s?-?[\d,]+\.\d{2}/g });
  return { text, drawn: [...text, ...drawn] };
}
