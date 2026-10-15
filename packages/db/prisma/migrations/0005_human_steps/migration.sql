-- Human steps (M4): a supervisor's code is asked for on its own, and "take over" is an action, not a
-- kind of task; the kind it stood for is an escalation. Renamed in place, so no row is lost.
ALTER TYPE "HumanTaskKind" RENAME VALUE 'take_over' TO 'escalation';
ALTER TYPE "HumanTaskKind" ADD VALUE 'supervisor_code' BEFORE 'escalation';

-- What a person did and why, what they recorded by hand, and how often the agent asked.
ALTER TABLE "HumanTask" ADD COLUMN     "action" TEXT,
ADD COLUMN     "asks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAskedAt" TIMESTAMP(3),
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "resolution" JSONB,
ADD COLUMN     "resolvable" BOOLEAN NOT NULL DEFAULT true;

-- The inbox reads open tasks by deadline.
CREATE INDEX "HumanTask_status_deadline_idx" ON "HumanTask"("status", "deadline");
