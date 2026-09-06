import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';

import { PlanAdaptationRequestedEvent } from 'src/events';

import { PlanAdaptationService } from './plan-adaptation.service';

/**
 * Plan adaptation scheduling
 *
 * Two paths into the same evaluation:
 *
 *  - A **weekly pass** on Sunday evening, which is when a training week ends
 *    and the next one needs to be right.
 *  - An **event-driven pass** when something happens that should not wait for
 *    Sunday: an injury reported in post-activity feedback, or a training load
 *    recalculation that reveals a spike. Waiting five days to react to a
 *    reported injury is exactly the failure a coach is supposed to prevent.
 */
@Injectable()
export class PlanAdaptationScheduler {
  private readonly logger = new Logger(PlanAdaptationScheduler.name);

  /** Guards against an athlete being evaluated twice concurrently. */
  private readonly inFlight = new Set<number>();

  constructor(private readonly adaptation: PlanAdaptationService) {}

  /** Sunday at 20:00, as the training week closes. */
  @Cron('0 20 * * 0')
  async weeklyPass() {
    this.logger.log('Running weekly plan adaptation pass');

    const adjusted = await this.adaptation.adaptAllActivePlans();

    this.logger.log(`Weekly plan adaptation adjusted ${adjusted} plan(s)`);
  }

  @OnEvent(PlanAdaptationRequestedEvent.SLUG, { async: true })
  async handleAdaptationRequested(event: PlanAdaptationRequestedEvent) {
    const { athleteId, reason } = event.payload;

    if (this.inFlight.has(athleteId)) {
      return;
    }

    this.inFlight.add(athleteId);

    try {
      const result = await this.adaptation.adaptAthlete(athleteId);

      if (result.adjusted) {
        this.logger.log(
          `Adapted athlete ${athleteId}'s plan after ${reason}: ${result.trigger}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Plan adaptation failed for athlete ${athleteId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.inFlight.delete(athleteId);
    }
  }
}
