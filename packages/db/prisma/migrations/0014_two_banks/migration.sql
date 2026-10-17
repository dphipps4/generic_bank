-- Two banks: Sample Savings Bank and Placeholder Federal Credit Union leave the registry, with
-- everything kept about them. Children go before their parents, since every foreign key here
-- restricts deletes.

-- The runs on them, the factory's crawls among them, and what each run left behind.
DELETE FROM "ApprovalGrant" WHERE "humanTaskId" IN (
  SELECT h.id FROM "HumanTask" h JOIN "TaskRun" r ON r.id = h."runId"
  WHERE r.bank IN ('sample', 'placeholder'));
DELETE FROM "HumanTask" WHERE "runId" IN (SELECT id FROM "TaskRun" WHERE bank IN ('sample', 'placeholder'));
DELETE FROM "Step" WHERE "runId" IN (SELECT id FROM "TaskRun" WHERE bank IN ('sample', 'placeholder'));
DELETE FROM "TrailFrame" WHERE "runId" IN (SELECT id FROM "TaskRun" WHERE bank IN ('sample', 'placeholder'));
DELETE FROM "JournalEntry" WHERE "runId" IN (SELECT id FROM "TaskRun" WHERE bank IN ('sample', 'placeholder'));
DELETE FROM "EpisodeOutbox" WHERE "runId" IN (SELECT id FROM "TaskRun" WHERE bank IN ('sample', 'placeholder'));
DELETE FROM "TaskRun" WHERE bank IN ('sample', 'placeholder');

-- The factory's runs on them: their model calls, checks and recommendations.
DELETE FROM "ModelCall" WHERE "factoryRunId" IN (SELECT id FROM "FactoryRun" WHERE tenant IN ('sample', 'placeholder'));
DELETE FROM "EvalResult" WHERE "factoryRunId" IN (SELECT id FROM "FactoryRun" WHERE tenant IN ('sample', 'placeholder'))
  OR "driverVersionId" IN (
    SELECT v.id FROM "DriverVersion" v JOIN "Driver" d ON d.id = v."driverId"
    WHERE d.tenant IN ('sample', 'placeholder'));
DELETE FROM "Recommendation" WHERE tenant IN ('sample', 'placeholder')
  OR "factoryRunId" IN (SELECT id FROM "FactoryRun" WHERE tenant IN ('sample', 'placeholder'));
DELETE FROM "FactoryRun" WHERE tenant IN ('sample', 'placeholder');

-- Their drivers, every version and every registry event.
DELETE FROM "RegistryEvent" WHERE "driverId" IN (SELECT id FROM "Driver" WHERE tenant IN ('sample', 'placeholder'));
DELETE FROM "DriverVersion" WHERE "driverId" IN (SELECT id FROM "Driver" WHERE tenant IN ('sample', 'placeholder'));
DELETE FROM "Driver" WHERE tenant IN ('sample', 'placeholder');

-- Their repair cases, freezes and sign-in attempts, and the banks themselves.
DELETE FROM "RepairCase" WHERE tenant IN ('sample', 'placeholder');
DELETE FROM "Freeze" WHERE tenant IN ('sample', 'placeholder');
DELETE FROM "SignInAttempt" WHERE tenant IN ('sample', 'placeholder');
DELETE FROM "Bank" WHERE id IN ('sample', 'placeholder');
