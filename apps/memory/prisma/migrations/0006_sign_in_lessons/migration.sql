-- Two more base lessons: a sign-in screen is named by what any visitor sees, never by what only a
-- browser the site already knows is shown.

INSERT INTO "Lesson" (id, current, base) VALUES
  ('base-scout-sign-in-name', 1, true),
  ('base-supervisor-sign-in-name', 1, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scope, state, "retiredAtBanks", confidence, seen, evidence, role, audience) VALUES
  ('base-scout-sign-in-name', 1, 'Name a sign-in screen by what any visitor sees there: its fields'' labels and its submit button. A greeting to a returning user, or anything else shown only because the site already knows this browser, is not part of its name: the service''s first run comes from a browser the site has never seen.', 'A route named its sign-in screen by a greeting shown only to a browser the site already trusted, and a new browser could not find that screen.', ARRAY['sign-in','name','greeting','browser']::text[], 'session', 'pattern', 'confirmed', '{}', 'high', true, '[{"run": "base", "frames": [], "hash": "5edc42e56d4aba1bf0dd30c2d2f44019ba738a8b47a4b25cb9637e639575951b", "seen": true}]'::jsonb, 'curator', 'scout'),
  ('base-supervisor-sign-in-name', 1, 'When the Scout names a sign-in screen, check that its words would be there for a browser the site has never seen. A greeting to a returning user is not; the fields'' labels and the submit button are.', 'A route named its sign-in screen by a greeting shown only to a browser the site already trusted, and a new browser could not find that screen.', ARRAY['sign-in','name','greeting','browser']::text[], 'session', 'pattern', 'confirmed', '{}', 'high', true, '[{"run": "base", "frames": [], "hash": "2b067d048426239b77d2952bc34a6f28a5cd0561165d6ffd96db19708a749eae", "seen": true}]'::jsonb, 'curator', 'supervisor')
ON CONFLICT ("lessonId", version) DO NOTHING;
