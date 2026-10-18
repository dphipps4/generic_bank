-- Runs no longer send episodes to memory: the recorder and its outbox are gone.
DROP TABLE "EpisodeOutbox";

-- The crawler-version states nothing ever used (candidate, probation, frozen) are gone. A Postgres
-- enum loses a value only by being rebuilt: the old type is renamed, the new one created, and each
-- column moved across.
ALTER TYPE "DriverState" RENAME TO "DriverState_old";
CREATE TYPE "DriverState" AS ENUM ('draft', 'promoted', 'demoted', 'stuck', 'retired');
ALTER TABLE "Driver" ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "DriverState" USING "state"::text::"DriverState",
  ALTER COLUMN "state" SET DEFAULT 'draft';
ALTER TABLE "DriverVersion" ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "DriverState" USING "state"::text::"DriverState",
  ALTER COLUMN "state" SET DEFAULT 'draft';
ALTER TABLE "RegistryEvent"
  ALTER COLUMN "fromState" TYPE "DriverState" USING "fromState"::text::"DriverState",
  ALTER COLUMN "toState" TYPE "DriverState" USING "toState"::text::"DriverState";
DROP TYPE "DriverState_old";
