-- Bank 2 is the factory's to learn: its check balance, written by hand and promoted in 0013, goes,
-- with its version and registry events, and anything that refers to them. Runs it made stay, as
-- history.
DELETE FROM "RegistryEvent" WHERE "driverId" = 'drv_example_check_balance';
UPDATE "Driver" SET "activeVersionId" = NULL WHERE id = 'drv_example_check_balance';
DELETE FROM "DriverVersion" WHERE "driverId" = 'drv_example_check_balance';
DELETE FROM "Driver" WHERE id = 'drv_example_check_balance';
