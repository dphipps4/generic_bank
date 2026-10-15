-- Generic Bank's Download Statements: the CoreLink driver with Generic Bank's profile, written by
-- hand and tested against the bank, promoted as Check Balance was.
INSERT INTO "Driver" (id, tenant, task, state, "activeVersionId") VALUES
  ('drv_generic_download_statements', 'generic', 'download-statements', 'promoted', 'dv_generic_download_statements_1')
ON CONFLICT (tenant, task) DO NOTHING;
INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state) VALUES
  ('dv_generic_download_statements_1', 'drv_generic_download_statements', 1, 'written-by-hand', 'profile', 'promoted')
ON CONFLICT ("driverId", version) DO NOTHING;
INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason) VALUES
  ('re_generic_download_statements_1', 'drv_generic_download_statements', 'draft', 'promoted', 'the build', 'written by hand and tested against the bank')
ON CONFLICT (id) DO NOTHING;
