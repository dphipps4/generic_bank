-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "inputsSealed" TEXT;

-- AlterTable
ALTER TABLE "HumanTask" ADD COLUMN     "answerSealed" TEXT;


-- Generic Bank's Check Balance: the CoreLink driver with Generic Bank's profile, written by hand,
-- promoted from the start. Every other bank and task is the factory's to earn.
INSERT INTO "Driver" (id, tenant, task, state, "activeVersionId") VALUES
  ('drv_generic_check_balance', 'generic', 'check-balance', 'promoted', 'dv_generic_check_balance_1')
ON CONFLICT (tenant, task) DO NOTHING;
INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state) VALUES
  ('dv_generic_check_balance_1', 'drv_generic_check_balance', 1, 'written-by-hand', 'profile', 'promoted')
ON CONFLICT ("driverId", version) DO NOTHING;
INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason) VALUES
  ('re_generic_check_balance_1', 'drv_generic_check_balance', 'draft', 'promoted', 'the build', 'written by hand and tested against the bank')
ON CONFLICT (id) DO NOTHING;
