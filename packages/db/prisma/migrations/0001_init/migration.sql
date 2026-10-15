-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('viewer', 'approver', 'admin');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('running', 'succeeded', 'business_outcome', 'needs_human', 'handed_off', 'escalated', 'failed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "HumanTaskKind" AS ENUM ('staff_code', 'approval', 'take_over');

-- CreateEnum
CREATE TYPE "HumanTaskStatus" AS ENUM ('open', 'answered', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "DriverState" AS ENUM ('draft', 'candidate', 'probation', 'promoted', 'demoted', 'frozen', 'stuck', 'retired');

-- CreateEnum
CREATE TYPE "BundleKind" AS ENUM ('profile', 'code');

-- CreateEnum
CREATE TYPE "EvalOutcome" AS ENUM ('passed', 'failed', 'could_not_run');

-- CreateTable
CREATE TABLE "ConsoleUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsoleUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "inputsMasked" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'running',
    "resultCode" TEXT,
    "retryable" BOOLEAN,
    "result" JSONB,
    "driverVersionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "screen" TEXT,
    "action" TEXT,
    "outcome" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ms" INTEGER,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailFrame" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stepSeq" INTEGER NOT NULL,
    "imageKey" TEXT,
    "withheldReason" TEXT,
    "screenModelKey" TEXT,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanTask" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "HumanTaskKind" NOT NULL,
    "status" "HumanTaskStatus" NOT NULL DEFAULT 'open',
    "contextMasked" JSONB NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HumanTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalGrant" (
    "id" TEXT NOT NULL,
    "humanTaskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fromRef" TEXT NOT NULL,
    "toRef" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "memoToken" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "action" TEXT,
    "result" TEXT,
    "prevHash" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "state" "DriverState" NOT NULL DEFAULT 'draft',
    "activeVersionId" TEXT,
    "candidateVersionId" TEXT,
    "previousVersionId" TEXT,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverVersion" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" "BundleKind" NOT NULL,
    "state" "DriverState" NOT NULL DEFAULT 'draft',
    "sourceFactoryRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryEvent" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "fromState" "DriverState" NOT NULL,
    "toState" "DriverState" NOT NULL,
    "by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryRun" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "spendUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "stalls" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactoryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL,
    "factoryRunId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "tokensIn" INTEGER NOT NULL,
    "tokensOut" INTEGER NOT NULL,
    "tokensCached" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,4) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "factoryRunId" TEXT,
    "driverVersionId" TEXT,
    "rung" TEXT NOT NULL,
    "outcome" "EvalOutcome" NOT NULL,
    "details" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairCase" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Freeze" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "runId" TEXT,
    "reason" TEXT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,

    CONSTRAINT "Freeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignInAttempt" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "runId" TEXT,
    "outcome" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignInAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleUser_email_key" ON "ConsoleUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_idempotencyKey_key" ON "TaskRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRun_tenant_task_startedAt_idx" ON "TaskRun"("tenant", "task", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Step_runId_seq_key" ON "Step"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TrailFrame_runId_seq_key" ON "TrailFrame"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalGrant_humanTaskId_key" ON "ApprovalGrant"("humanTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalGrant_nonce_key" ON "ApprovalGrant"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_rowHash_key" ON "JournalEntry"("rowHash");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_runId_seq_key" ON "JournalEntry"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_tenant_task_key" ON "Driver"("tenant", "task");

-- CreateIndex
CREATE UNIQUE INDEX "DriverVersion_driverId_version_key" ON "DriverVersion"("driverId", "version");

-- CreateIndex
CREATE INDEX "SignInAttempt_tenant_operator_at_idx" ON "SignInAttempt"("tenant", "operator", "at");

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailFrame" ADD CONSTRAINT "TrailFrame_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanTask" ADD CONSTRAINT "HumanTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalGrant" ADD CONSTRAINT "ApprovalGrant_humanTaskId_fkey" FOREIGN KEY ("humanTaskId") REFERENCES "HumanTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVersion" ADD CONSTRAINT "DriverVersion_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEvent" ADD CONSTRAINT "RegistryEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCall" ADD CONSTRAINT "ModelCall_factoryRunId_fkey" FOREIGN KEY ("factoryRunId") REFERENCES "FactoryRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_factoryRunId_fkey" FOREIGN KEY ("factoryRunId") REFERENCES "FactoryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

