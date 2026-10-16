// Least privilege, enforced: the factory-only secrets reach only the factory, and every secret
// a service asks for exists.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const scope = JSON.parse(readFileSync(new URL('infra/secrets/scope.json', root), 'utf8')) as {
  derived: Record<string, string>;
  services: Record<string, string[]>;
};
const spec = readFileSync(new URL('infra/secrets/secrets.spec', root), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('#'))
  .map((l) => l.trim().split(/\s+/) as [string, string, string]);

const fileOf = new Map(spec.map(([file, key]) => [key, file]));
const source = (entry: string) => entry.split('=').at(-1)!;

describe('secrets scope', () => {
  it('gives factory-only secrets to the factory alone', () => {
    for (const [svc, keys] of Object.entries(scope.services)) {
      if (svc === 'factory') continue;
      for (const k of keys) expect(fileOf.get(source(k)), `${svc}: ${k}`).not.toBe('factory');
    }
  });

  it('asks only for secrets that exist', () => {
    for (const [svc, keys] of Object.entries(scope.services)) {
      for (const k of keys) {
        const s = source(k);
        expect(fileOf.has(s) || s in scope.derived, `${svc}: ${s}`).toBe(true);
      }
    }
  });
});
