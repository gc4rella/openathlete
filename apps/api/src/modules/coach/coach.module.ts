import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth';
import { PrismaService } from '../prisma/services/prisma.service';
import { SubscriptionModule } from '../subscription';
import { AthleteAvailabilityController } from './controllers/athlete-availability.controller';
import { TrainingPlanController } from './controllers/training-plan.controller';
import { AthleteAvailabilityService } from './services/athlete-availability.service';
import { ChatGptPlannerProviderService } from './services/chatgpt-planner-provider.service';
import { PlanAdaptationScheduler } from './services/plan-adaptation.scheduler';
import { PlanAdaptationService } from './services/plan-adaptation.service';
import { PlanGenerationService } from './services/plan-generation.service';
import { PlanIntakeService } from './services/plan-intake.service';
import { PlanMaterializationService } from './services/plan-materialization.service';
import { PlanNarrativeService } from './services/plan-narrative.service';
import { TrainingPlanService } from './services/training-plan.service';

/**
 * Coach module
 *
 * Everything that turns OpenAthlete from a training log into a coach:
 * generating periodized plans, writing them into the calendar, and managing
 * the availability they are built around.
 */
@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => SubscriptionModule)],
  controllers: [TrainingPlanController, AthleteAvailabilityController],
  providers: [
    PrismaService,
    ChatGptPlannerProviderService,
    PlanGenerationService,
    PlanIntakeService,
    PlanMaterializationService,
    PlanNarrativeService,
    PlanAdaptationService,
    PlanAdaptationScheduler,
    TrainingPlanService,
    AthleteAvailabilityService,
  ],
  exports: [
    TrainingPlanService,
    PlanAdaptationService,
    PlanGenerationService,
    PlanMaterializationService,
    AthleteAvailabilityService,
  ],
})
export class CoachModule {}
