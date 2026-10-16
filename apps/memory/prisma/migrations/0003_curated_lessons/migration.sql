-- A curated lesson says why its advice holds, and the words that tell it applies.

-- AlterTable
ALTER TABLE "LessonVersion" ADD COLUMN     "signals" TEXT[],
ADD COLUMN     "why" TEXT;
