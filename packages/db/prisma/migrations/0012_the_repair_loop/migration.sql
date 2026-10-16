-- The repair loop (plan, Appendix L): a repair case remembers the run that faulted and the version
-- that ran it, and a factory run in repair mode starts from that version's profile.
ALTER TABLE "RepairCase" ADD COLUMN "runId" TEXT;
ALTER TABLE "RepairCase" ADD COLUMN "versionId" TEXT;
ALTER TABLE "FactoryRun" ADD COLUMN "baseVersionId" TEXT;

-- One open repair case per bank and task.
CREATE UNIQUE INDEX "RepairCase_one_open" ON "RepairCase"(tenant, task) WHERE status = 'open';
