ALTER TABLE "training_plan" ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "training_week" ADD COLUMN "phase" "cycle_phase";
ALTER TABLE "event_training" ADD COLUMN "adaptation_baseline" JSONB,
  ADD COLUMN "adaptation_scale" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "adaptation_severity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "event_activity" ADD COLUMN "import_metadata" JSONB;
