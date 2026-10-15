-- An idempotency key belongs to the client that sent it: another client's key is a new key, never
-- a way to read someone else's run.
DROP INDEX "TaskRun_idempotencyKey_key";
CREATE UNIQUE INDEX "TaskRun_clientId_idempotencyKey_key" ON "TaskRun"("clientId", "idempotencyKey");

-- A keyed hash of what makes two transfers the same (bank, member, accounts, amount). Written by
-- hand: Prisma cannot express a partial index. While a run is open (running, waiting on a person,
-- or escalated), no second run may carry its key, so the database itself refuses the duplicate.
ALTER TABLE "TaskRun" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "TaskRun_dedupeKey_open_key" ON "TaskRun"("dedupeKey")
  WHERE status IN ('running', 'needs_human', 'escalated');
