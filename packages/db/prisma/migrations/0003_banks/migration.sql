-- CreateTable
CREATE TABLE "Bank" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "productVersion" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);


-- The four banks of the local world. Their consoles are reached on the compose network.
INSERT INTO "Bank" (id, brand, "productVersion", url, position) VALUES
  ('generic', 'Generic Bank', 'CoreLink 4.2', 'http://bank-generic:8081/corelink/', 1),
  ('example', 'Example Credit Union', 'CoreLink 4.3', 'http://bank-example:8082/', 2),
  ('sample', 'Sample Savings Bank', 'CoreLink 4.3', 'http://bank-sample:8083/online/branch/', 3),
  ('placeholder', 'Placeholder Federal Credit Union', 'CoreLink 4.4', 'http://bank-placeholder:8084/cu/ib/', 4)
ON CONFLICT (id) DO NOTHING;
