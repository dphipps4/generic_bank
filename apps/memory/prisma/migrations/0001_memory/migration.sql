-- Memory's first tables. pgvector holds lesson embeddings; the compose Postgres creates the
-- extension at init, and this makes the migration stand on its own.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('runner', 'factory', 'curator', 'system');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('task', 'factory');

-- CreateEnum
CREATE TYPE "Mark" AS ENUM ('promoted', 'demoted');

-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('tenant', 'vendor', 'pattern');

-- CreateEnum
CREATE TYPE "LessonState" AS ENUM ('proposed', 'confirmed', 'disputed', 'retired');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "CatalogKind" AS ENUM ('rule', 'check', 'scenario', 'approach');

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "bank" TEXT NOT NULL,
    "vendor" TEXT,
    "task" TEXT,
    "driver" TEXT,
    "outcome" TEXT NOT NULL,
    "mark" "Mark",
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "model" TEXT,
    "prompts" JSONB,
    "evidenceHash" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "runId" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "failure" TEXT,
    "frames" TEXT[],
    "evidenceHash" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("runId","n")
);

-- CreateTable
CREATE TABLE "Hypothesis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT,
    "prompts" JSONB,
    "evidenceHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bank" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "validAt" TIMESTAMPTZ(3) NOT NULL,
    "invalidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "Fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "current" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonVersion" (
    "lessonId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "scenario" TEXT,
    "scope" "Scope" NOT NULL,
    "bank" TEXT,
    "vendor" TEXT,
    "state" "LessonState" NOT NULL,
    "retiredAtBanks" TEXT[],
    "confidence" "Confidence" NOT NULL,
    "seen" BOOLEAN NOT NULL,
    "evidence" JSONB NOT NULL,
    "reason" TEXT,
    "role" "Role" NOT NULL,
    "runId" TEXT,
    "model" TEXT,
    "prompts" JSONB,
    "evidenceHash" TEXT,
    "embedding" vector(384),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonVersion_pkey" PRIMARY KEY ("lessonId","version")
);

-- CreateTable
CREATE TABLE "CatalogEntry" (
    "kind" "CatalogKind" NOT NULL,
    "key" TEXT NOT NULL,
    "current" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CatalogEntry_pkey" PRIMARY KEY ("kind","key")
);

-- CreateTable
CREATE TABLE "CatalogVersion" (
    "kind" "CatalogKind" NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "role" "Role" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogVersion_pkey" PRIMARY KEY ("kind","key","version")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "role" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT,
    "data" JSONB NOT NULL,
    "prevHash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "Run_bank_startedAt_idx" ON "Run"("bank", "startedAt");

-- CreateIndex
CREATE INDEX "Fact_bank_predicate_idx" ON "Fact"("bank", "predicate");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeLog_hash_key" ON "ChangeLog"("hash");

-- CreateIndex
CREATE INDEX "ChangeLog_entity_entityId_idx" ON "ChangeLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "ChangeLog_runId_idx" ON "ChangeLog"("runId");

-- CreateIndex
CREATE INDEX "ChangeLog_at_idx" ON "ChangeLog"("at");

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonVersion" ADD CONSTRAINT "LessonVersion_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogVersion" ADD CONSTRAINT "CatalogVersion_kind_key_fkey" FOREIGN KEY ("kind", "key") REFERENCES "CatalogEntry"("kind", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

