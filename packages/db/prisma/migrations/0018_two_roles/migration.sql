-- Two roles: a viewer reads, an admin acts (approves transfers and learned tables, clears freezes,
-- manages API clients). Anyone who was an approver is an admin. The enum keeps its old value
-- unused: removing a value from a Postgres enum is a rewrite not worth its risk.
UPDATE "ConsoleUser" SET role = 'admin' WHERE role = 'approver';
