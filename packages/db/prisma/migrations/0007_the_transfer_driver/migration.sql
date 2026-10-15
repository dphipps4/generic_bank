-- Generic Bank's Transfer: the CoreLink driver with Generic Bank's profile, written by hand and
-- promoted, as Check Balance was. It prepares, waits for a person's approval, and submits once
-- under the grant. Every other bank and task is the factory's to earn.
INSERT INTO "Driver" (id, tenant, task, state, "activeVersionId") VALUES
  ('drv_generic_transfer', 'generic', 'transfer', 'promoted', 'dv_generic_transfer_1')
ON CONFLICT (tenant, task) DO NOTHING;
INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state) VALUES
  ('dv_generic_transfer_1', 'drv_generic_transfer', 1, 'written-by-hand', 'profile', 'promoted')
ON CONFLICT ("driverId", version) DO NOTHING;
INSERT INTO "RegistryEvent" (id, "driverId", "fromState", "toState", by, reason) VALUES
  ('re_generic_transfer_1', 'drv_generic_transfer', 'draft', 'promoted', 'the build', 'written by hand and tested against the bank')
ON CONFLICT (id) DO NOTHING;
