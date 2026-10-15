-- The model gateway records every call; a call names its prompt once prompts are reviewed files.
ALTER TABLE "ModelCall" ALTER COLUMN "promptId" DROP NOT NULL;
ALTER TABLE "ModelCall" ALTER COLUMN "promptVersion" DROP NOT NULL;
