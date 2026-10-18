// Bank 1's crawler, written as the factory's Scout would write one: the tests' own, for a bank we
// may know. Never shown to the factory.
/** Bank 1's crawler, as a factory would write it: it reads each page, then acts. */
export const BANK1 = `
async function arrive(site, task, there) {
  await site.open();
  for (let i = 0; i < 25; i++) {
    const { lines } = await site.look();
    const has = (w) => lines.some((l) => l.includes(w));
    if (there(has)) return;
    if (has('Welcome back')) {
      await site.type('Password', 'password');
      await site.press('Sign In');
    } else if (has('Operator ID')) {
      await site.type('Operator ID', 'user_id');
      await site.type('Password', 'password');
      await site.press('Sign In');
    } else if (has('Where should we send your code?')) await site.press('Send code');
    else if (has('That code has expired.')) await site.press('Send a new code');
    else if (has('Enter the 6-digit code we sent')) {
      await site.type('Code', 'code');
      await site.press('Verify');
    } else if (has('Member number:') && has('Status')) await site.press('Open');
    else if (has('Member number:')) {
      await site.type('Member number', 'member');
      await site.press('Search');
    } else if (has('Use Member Search to begin.') || has('New in CoreLink'))
      await site.press('Member Search');
    else await site.wait(1);
  }
  throw new Error('never reached the page it was going to');
}
const summary = (has) => has('Member Summary') && has('Available balance:');

async function balance(site, task) {
  await arrive(site, task, summary);
  const { lines } = await site.look();
  const tile = lines.find((l) => l.includes(task.from) && l.includes('Available balance:'));
  if (!tile) site.stop('no_such_account', 'no tile holds the account');
  const m = tile.match(/^(.*) Available balance: (\\S+) Current balance: (\\S+)/);
  return { account: m[1], available: m[2], current: m[3] };
}
async function transfer(site, task) {
  await arrive(site, task, summary);
  await site.press({ name: 'Transfer Funds', near: 'Member Summary' });
  await site.choose('From', 'from');
  await site.choose('To', 'to');
  await site.type('Amount', 'amount');
  await site.type('Memo', 'memo');
  await site.press('Continue');
}
async function review(site) {
  const { lines } = await site.look();
  const after = (label) => lines[lines.indexOf(label) + 1];
  return { from: after('From:'), to: after('To:'), amount: after('Amount:'), memo: after('Memo:') };
}
async function history(site, task) {
  await arrive(site, task, summary);
  await site.press({ name: 'Activity', near: task.from });
}
function name(lines, member) {
  const l = lines.find((x) => x.startsWith('Member ') && x.includes(' · '));
  return l ? l.split(' · ')[1] : null;
}
const send = 'Submit transfer';
`;
