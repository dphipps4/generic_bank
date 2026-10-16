-- Example Credit Union's Check Balance: the same CoreLink driver with bank 2's own profile, written
-- by hand and tested against the bank, promoted as Generic Bank's was. Banks 3 and 4 are the
-- factory's to earn.
INSERT INTO "Driver" (id, tenant, task, state, "activeVersionId") VALUES
  ('drv_example_check_balance', 'example', 'check-balance', 'promoted', 'dv_example_check_balance_1')
ON CONFLICT (tenant, task) DO NOTHING;
INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state) VALUES
  ('dv_example_check_balance_1', 'drv_example_check_balance', 1, 'written-by-hand', 'profile', 'promoted')
ON CONFLICT ("driverId", version) DO NOTHING;
INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason) VALUES
  ('re_example_check_balance_1', 'drv_example_check_balance', 'draft', 'promoted', 'the build', 'written by hand and tested against the bank')
ON CONFLICT (id) DO NOTHING;
