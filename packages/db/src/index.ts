// The control database: one Prisma schema for runs, evidence, the registry and the factory.
import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/** One client per process. */
export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export { sql, type Sql } from './sql.js';
