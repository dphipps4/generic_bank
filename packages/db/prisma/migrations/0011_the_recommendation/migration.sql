-- The Supervisor's recommendation: the bank's profile drafted from a factory run's frames, one per
-- run. Each claim cites frames of the run and is marked seen or guess; a person decides it.
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "factoryRunId" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "claims" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Recommendation_factoryRunId_key" ON "Recommendation"("factoryRunId");

ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_factoryRunId_fkey" FOREIGN KEY ("factoryRunId") REFERENCES "FactoryRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
