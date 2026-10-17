-- A learned table (prompts, part 2): the factory's crawler is data. It is kept with the
-- recommendation a person decides, beside its live check, and with the version it becomes once
-- approved. A version with no table runs its bank's hand-written one.
ALTER TYPE "BundleKind" ADD VALUE 'table';
ALTER TABLE "Recommendation" ADD COLUMN "table" JSONB, ADD COLUMN "check" JSONB;
ALTER TABLE "Recommendation" ALTER COLUMN claims SET DEFAULT '[]';
ALTER TABLE "DriverVersion" ADD COLUMN "table" JSONB;
