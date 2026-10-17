-- Two tasks: check balance and transfer. Download Statements is no longer a task, so its drivers,
-- their versions and their registry events go, on every bank. The runs it made stay, as history.
DELETE FROM "RegistryEvent"
 WHERE "driverId" IN (SELECT id FROM "Driver" WHERE task = 'download-statements');
DELETE FROM "DriverVersion"
 WHERE "driverId" IN (SELECT id FROM "Driver" WHERE task = 'download-statements');
DELETE FROM "Driver" WHERE task = 'download-statements';

-- No client, and no token, keeps a scope that no longer exists.
UPDATE "ApiClient" SET scopes = array_remove(scopes, 'tasks:statements')
 WHERE 'tasks:statements' = ANY (scopes);
UPDATE "ApiToken" SET scopes = array_remove(scopes, 'tasks:statements')
 WHERE 'tasks:statements' = ANY (scopes);

-- The hash-chained journal goes. A run's steps and frames are its record; a transfer's intent to
-- press is a step, written before the click.
DROP TABLE "JournalEntry";
