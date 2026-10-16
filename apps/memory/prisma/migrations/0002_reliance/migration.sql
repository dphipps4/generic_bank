-- The served lessons each run relied on, which the rules read when a promotion confirms them.

-- CreateTable
CREATE TABLE "Reliance" (
    "runId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reliance_pkey" PRIMARY KEY ("runId","lessonId")
);

-- CreateIndex
CREATE INDEX "Reliance_lessonId_idx" ON "Reliance"("lessonId");

-- AddForeignKey
ALTER TABLE "Reliance" ADD CONSTRAINT "Reliance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reliance" ADD CONSTRAINT "Reliance_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
