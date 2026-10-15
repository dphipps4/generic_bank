-- Box B's databases: the control database (Prisma) and Memory's own database.
CREATE DATABASE control;
CREATE DATABASE memory;
\connect memory
CREATE EXTENSION IF NOT EXISTS vector;
