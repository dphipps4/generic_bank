-- The recorder's outbox: each settlement of a run is one attempt of its episode, waiting for memory.
CREATE TABLE "EpisodeOutbox" (
    "runId" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "failure" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "refused" TEXT,

    CONSTRAINT "EpisodeOutbox_pkey" PRIMARY KEY ("runId","n")
);

-- CreateIndex
CREATE INDEX "EpisodeOutbox_sentAt_idx" ON "EpisodeOutbox"("sentAt");

-- AddForeignKey
ALTER TABLE "EpisodeOutbox" ADD CONSTRAINT "EpisodeOutbox_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
