ALTER TABLE "GenerationHistory"
  ADD COLUMN "intent" TEXT,
  ADD COLUMN "used_auto_repair" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GenerationJob"
  ADD COLUMN "intent" TEXT,
  ADD COLUMN "used_auto_repair" BOOLEAN NOT NULL DEFAULT false;
