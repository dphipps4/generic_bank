-- CreateEnum
CREATE TYPE "TokenKind" AS ENUM ('access', 'refresh');

-- Written by hand: the generated migration dropped "tenant" and added "bank" NOT NULL, which
-- fails on a table with rows and throws their values away. A rename keeps both.
ALTER TABLE "TaskRun" RENAME COLUMN "tenant" TO "bank";
ALTER INDEX "TaskRun_tenant_task_startedAt_idx" RENAME TO "TaskRun_bank_task_startedAt_idx";
ALTER TABLE "TaskRun" ADD COLUMN "clientId" TEXT,
ALTER COLUMN "idempotencyKey" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCode" (
    "id" TEXT NOT NULL,
    "clientPk" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "ApiCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenFamily" (
    "id" TEXT NOT NULL,
    "clientPk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "TokenFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "kind" "TokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "spentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_clientId_key" ON "ApiClient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCode_codeHash_key" ON "ApiCode"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_familyId_idx" ON "ApiToken"("familyId");

-- AddForeignKey
ALTER TABLE "ApiCode" ADD CONSTRAINT "ApiCode_clientPk_fkey" FOREIGN KEY ("clientPk") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenFamily" ADD CONSTRAINT "TokenFamily_clientPk_fkey" FOREIGN KEY ("clientPk") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "TokenFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

