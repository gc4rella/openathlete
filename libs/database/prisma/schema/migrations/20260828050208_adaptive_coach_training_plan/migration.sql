-- CreateEnum
CREATE TYPE "public"."plan_adjustment_trigger" AS ENUM ('LOAD_SPIKE', 'LOW_COMPLETION', 'INJURY', 'RPE_OVERSHOOT', 'UNDERLOAD', 'MANUAL');

-- AlterTable
ALTER TABLE "public"."event_training" ADD COLUMN     "manually_edited" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."training_plan" ADD COLUMN     "days_per_week" INTEGER,
ADD COLUMN     "generation_input" JSONB,
ADD COLUMN     "generator_version" TEXT,
ADD COLUMN     "race_date" TIMESTAMP(3),
ADD COLUMN     "sport_type" "public"."sport_type" NOT NULL DEFAULT 'RUNNING',
ADD COLUMN     "target_distance" DOUBLE PRECISION,
ADD COLUMN     "target_time" INTEGER;

-- CreateTable
CREATE TABLE "public"."training_plan_adjustment" (
    "training_plan_adjustment_id" SERIAL NOT NULL,
    "trigger" "public"."plan_adjustment_trigger" NOT NULL,
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT true,
    "training_plan_id" INTEGER NOT NULL,
    "training_week_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_plan_adjustment_pkey" PRIMARY KEY ("training_plan_adjustment_id")
);

-- CreateIndex
CREATE INDEX "training_plan_adjustment_training_plan_id_created_at_idx" ON "public"."training_plan_adjustment"("training_plan_id", "created_at");

-- CreateIndex
CREATE INDEX "training_plan_adjustment_training_week_id_idx" ON "public"."training_plan_adjustment"("training_week_id");

-- AddForeignKey
ALTER TABLE "public"."training_plan_adjustment" ADD CONSTRAINT "training_plan_adjustment_training_plan_id_fkey" FOREIGN KEY ("training_plan_id") REFERENCES "public"."training_plan"("training_plan_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."training_plan_adjustment" ADD CONSTRAINT "training_plan_adjustment_training_week_id_fkey" FOREIGN KEY ("training_week_id") REFERENCES "public"."training_week"("training_week_id") ON DELETE SET NULL ON UPDATE CASCADE;
