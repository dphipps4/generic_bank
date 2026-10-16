// make memory-seed: the starting knowledge, through memory's door, as the curator. It fails unless
// memory then serves every entry the manifest counts and the change log verifies.
import { loadConfig, secret } from '@gb/config';
import { z } from 'zod';
import { readSeed, seed } from './seed.js';

const cfg = loadConfig(
  {
    MEMORY_URL: z.url(),
    MEMORY_TOKEN_CURATOR: secret(),
    MEMORY_SIGNING_KEY: secret(),
    MEMORY_SEED_DIR: z.string().min(1).default('seeds/memory'),
  },
  process.env,
  ['MEMORY_TOKEN_CURATOR', 'MEMORY_SIGNING_KEY'],
);

try {
  const want = readSeed(cfg.MEMORY_SEED_DIR).manifest.files;
  const out = await seed({
    dir: cfg.MEMORY_SEED_DIR,
    url: cfg.MEMORY_URL,
    token: cfg.MEMORY_TOKEN_CURATOR,
    signingKey: cfg.MEMORY_SIGNING_KEY,
  });
  const verify = (await (
    await fetch(`${cfg.MEMORY_URL}/history/verify`, {
      headers: { authorization: `Bearer ${cfg.MEMORY_TOKEN_CURATOR}` },
    })
  ).json()) as { ok: boolean; rows: number };

  let ok = verify.ok;
  for (const [name, n] of Object.entries(out.served)) {
    const expected = want[name as keyof typeof want].entries;
    ok &&= n === expected;
    console.log(`  ${name.padEnd(11)} ${String(n).padStart(4)} of ${expected}`);
  }
  console.log(
    `  written     ${String(out.written).padStart(4)} versions, ${out.approved} approved`,
  );
  console.log(`  change log  ${verify.ok ? 'verifies' : 'DOES NOT VERIFY'} (${verify.rows} rows)`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`memory-seed: ${(e as Error).message}`);
  process.exit(1);
}
