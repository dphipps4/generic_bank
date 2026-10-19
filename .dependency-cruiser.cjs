// Import boundaries from the plan (Appendix Q). CI fails on any violation.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'crawler-sees-no-bank',
      comment: 'The crawler knows a bank only by its table, written from evidence: never its code.',
      severity: 'error',
      from: { path: '^packages/crawler/src/' },
      to: { path: '^(apps/|packages/(?!crawler/|runtime/|contracts/))' },
    },
    {
      name: 'runtime-stands-alone',
      comment: 'The runtime knows no bank and no app: it is the browser, seeing and acting.',
      severity: 'error',
      from: { path: '^packages/runtime/' },
      to: { path: '^(apps/|packages/(?!runtime/))' },
    },
    {
      name: 'nothing-imports-the-bank',
      comment: 'The bank is the outside world. It is reached only over HTTP.',
      severity: 'error',
      // The end-to-end tests start the bank in process and read its seeded members; the next rule
      // keeps its config from them.
      from: { pathNot: '^(apps/bank/|tests/)' },
      to: { path: '^apps/bank/' },
    },
    {
      name: 'only-the-bank-harness-reads-its-config',
      comment:
        "A bank's config (its words, labels and layout) is the answer key. Only the harness that starts a bank, the bank's own tests and the PII check's seeded values read it.",
      severity: 'error',
      from: {
        path: '^(apps/factory/|tests/)',
        pathNot: '^tests/(bank/|support/banks\\.ts$|pii/seeded\\.ts$)',
      },
      to: { path: '^apps/bank/src/tenants' },
    },
    {
      name: 'the-bank-imports-nothing-of-ours',
      comment: 'The bank shares no code with the automation, so the automation cannot cheat.',
      severity: 'error',
      from: { path: '^apps/bank/' },
      to: { path: '^(apps/(?!bank/)|packages/)' },
    },
    {
      name: 'guards-and-evals-stay-independent',
      comment: 'Guardrails, evals and lint never import the runner or the factory.',
      severity: 'error',
      from: { path: '^packages/(guardrails|evals|lint)/' },
      to: { path: '^apps/(runner|factory)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
