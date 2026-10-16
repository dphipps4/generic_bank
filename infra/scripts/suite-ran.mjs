// A suite that is skipped proves nothing, and a skipped test passes. This reads vitest's JSON
// report and fails if any test in the named folders or files did not run, and, for one given as
// path=count, if fewer than that many passed.
//   node infra/scripts/suite-ran.mjs .run/report.json tests/escalation=9
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import process from 'node:process';

const [file, ...suites] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const tests = report.testResults.flatMap((f) =>
  f.assertionResults.map((t) => ({ file: relative(process.cwd(), f.name), ...t })),
);

let ok = true;
for (const suite of suites) {
  const [path, least = '0'] = suite.split('=');
  const mine = tests.filter((t) => t.file === path || t.file.startsWith(`${path}/`));
  const passed = mine.filter((t) => t.status === 'passed').length;
  const notRun = mine.filter((t) => t.status !== 'passed' && t.status !== 'failed');
  for (const t of notRun) console.error(`${t.status}: ${t.file} > ${t.fullName}`);
  console.log(`${path}: ${passed} passed, ${notRun.length} not run (at least ${least} must pass)`);
  if (notRun.length > 0 || passed < Number(least)) ok = false;
}
process.exit(ok ? 0 : 1);
