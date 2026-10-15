import { describe, expect, it } from 'vitest';
import { stripSecrets } from '../src/resources.js';

describe('stripSecrets', () => {
  it('removes the password hash from a single record and from lists', () => {
    const one = stripSecrets({ record: { params: { email: 'a@b.c', passwordHash: 'x' } } });
    expect(one.record?.params).toEqual({ email: 'a@b.c' });
    const many = stripSecrets({ records: [{ params: { passwordHash: 'x', role: 'admin' } }] });
    expect(many.records?.[0]?.params).toEqual({ role: 'admin' });
  });
});
