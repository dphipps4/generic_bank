-- What nothing reads or writes any more: attempts, hypotheses, facts, the curated catalog, the
-- change log and a run's mark. Then the roles narrow to the factory and a person.

-- DropForeignKey
ALTER TABLE "Attempt" DROP CONSTRAINT "Attempt_runId_fkey";

-- DropForeignKey
ALTER TABLE "CatalogVersion" DROP CONSTRAINT "CatalogVersion_kind_key_fkey";

-- DropForeignKey
ALTER TABLE "Fact" DROP CONSTRAINT "Fact_runId_fkey";

-- DropForeignKey
ALTER TABLE "Hypothesis" DROP CONSTRAINT "Hypothesis_runId_fkey";

-- AlterTable
ALTER TABLE "Run" DROP COLUMN "mark";

-- DropTable
DROP TABLE "Attempt";

-- DropTable
DROP TABLE "CatalogEntry";

-- DropTable
DROP TABLE "CatalogVersion";

-- DropTable
DROP TABLE "ChangeLog";

-- DropTable
DROP TABLE "Fact";

-- DropTable
DROP TABLE "Hypothesis";

-- DropEnum
DROP TYPE "CatalogKind";

-- DropEnum
DROP TYPE "Mark";

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('factory', 'curator');
ALTER TABLE "LessonVersion" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
COMMIT;
