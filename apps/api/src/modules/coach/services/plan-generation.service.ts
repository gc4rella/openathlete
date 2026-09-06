import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { Gender, RecordType, SportType } from '@openathlete/database';
import {
  METRIC_TYPE,
  PLAN_GOAL_KIND,
  type PlanGenerationInput,
  SPORT_TYPE,
  TRAINING_ZONE_TYPE,
} from '@openathlete/shared';

import { PrismaService } from '../../prisma/services/prisma.service';
import {
  type AvailabilitySlot,
  type BestEffort,
  type EngineInput,
  type GeneratePlanResult,
  type InjurySignal,
  RunIntensity,
  type ZoneIdByIntensity,
  generatePlan,
  weeksUntil,
} from '../engine';

/**
 * Plan generation
 *
 * Assembles the athlete's real training context and hands it to the
 * deterministic engine.
 *
 * Everything the engine needs comes from data the app already collects: the
 * metrics synced from the athlete's watch, their personal records, their
 * declared availability, their open injuries, and the volume they have
 * actually been running. Nothing is asked for twice in the wizard if it can be
 * read from the database.
 */

const WEEKS_OF_HISTORY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Efforts older than this no longer describe current fitness. */
const EFFORT_LOOKBACK_DAYS = 180;
const MIN_EFFORT_DISTANCE_METERS = 1500;

/** Sports whose volume counts towards a running plan's baseline. */
const RUNNING_SPORTS: SportType[] = [
  SportType.RUNNING,
  SportType.TRAIL_RUNNING,
  SportType.VIRTUAL_RUN,
];

export interface AthleteContext {
  currentWeeklyVolume: number | null;
  availability: AvailabilitySlot[];
  injuries: InjurySignal[];
  bestEfforts: BestEffort[];
  zoneIds: ZoneIdByIntensity | undefined;
}

@Injectable()
export class PlanGenerationService {
  private readonly logger = new Logger(PlanGenerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build a plan for an athlete from the wizard input plus their own data.
   */
  async generate(
    athleteId: number,
    input: PlanGenerationInput,
    language: 'EN' | 'FR' | 'IT',
  ): Promise<GeneratePlanResult> {
    const engineInput = await this.buildEngineInput(athleteId, input, language);

    let result: GeneratePlanResult;
    try { result = generatePlan(engineInput); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Invalid training plan"); }

    this.logger.log(
      `Generated a ${result.plan.plan.duration} week plan for athlete ${athleteId} ` +
        `(fitness source: ${result.fitness.source}, VDOT ${result.fitness.currentVdot.toFixed(1)})`,
    );

    return result;
  }

  async buildEngineInput(
    athleteId: number,
    input: PlanGenerationInput,
    language: 'EN' | 'FR' | 'IT',
  ): Promise<EngineInput> {
    const [athlete, context] = await Promise.all([
      this.prisma.athlete.findUnique({
        where: { athleteId },
        include: { user: true },
      }),
      this.gatherContext(athleteId),
    ]);

    const metrics = await this.latestMetrics(athleteId);

    const durationWeeks = this.resolveDurationWeeks(input);

    return {
      timeZone: input.timeZone,
      recentLongestRun: input.recentLongestRun ?? await this.recentLongestRun(athleteId),
      sport: input.sport,
      startDate: input.startDate,
      raceDate: input.raceDate ?? null,
      targetDistance: input.targetDistance ?? null,
      targetTime: input.targetTime ?? null,
      durationWeeks,
      daysPerWeek: input.daysPerWeek,
      longRunDay: input.longRunDay ?? null,
      // The wizard prefills this from history, but an explicit answer wins.
      currentWeeklyVolume:
        input.currentWeeklyVolume ?? context.currentWeeklyVolume,
      includeCrossTraining: input.includeCrossTraining,
      injuryAware: input.injuryAware,
      planName: input.planName ?? null,
      fitness: {
        vmaKmh: metrics[METRIC_TYPE.VMA] ?? null,
        vo2max: metrics[METRIC_TYPE.VO2MAX] ?? null,
        hrMax: metrics[METRIC_TYPE.HR_MAX] ?? null,
        hrRest: metrics[METRIC_TYPE.HR_REST] ?? null,
        gender: athlete?.user.gender === Gender.FEMALE ? 'female' : 'male',
        bestEfforts: context.bestEfforts,
      },
      availability: context.availability,
      injuries: context.injuries,
      zoneIds: context.bestEfforts.length > 0 ? undefined : context.zoneIds,
      language,
    };
  }

  /**
   * Number of weeks the plan should run for.
   * A race plan is as long as the time available; a fitness plan is as long as
   * the athlete asked for.
   */
  resolveDurationWeeks(input: PlanGenerationInput): number {
    if (input.goalKind === PLAN_GOAL_KIND.RACE && input.raceDate) {
      return weeksUntil(input.startDate, input.raceDate);
    }

    return input.durationWeeks ?? 12;
  }

  /**
   * The athlete's average weekly training volume over recent history, in
   * seconds. Used as the starting point of the ramp, so a plan begins where
   * the athlete actually is.
   */
  async recentWeeklyVolume(athleteId: number): Promise<number | null> {
    const since = new Date(Date.now() - WEEKS_OF_HISTORY * 7 * DAY_MS);

    const activities = await this.prisma.eventActivity.findMany({
      where: {
        event: { athleteId, startDate: { gte: since } },
        sport: { in: RUNNING_SPORTS },
      },
      select: { movingTime: true, event: { select: { startDate: true } } },
    });

    if (activities.length === 0) {
      return null;
    }

    const total = activities.reduce(
      (sum, activity) => sum + (activity.movingTime ?? 0),
      0,
    );

    const oldest = Math.min(...activities.map((activity) => activity.event.startDate.getTime()));
    const observedWeeks = Math.min(WEEKS_OF_HISTORY, Math.max(1, (Date.now() - oldest) / (7 * DAY_MS)));
    return Math.round(total / observedWeeks);
  }

  async recentLongestRun(athleteId: number): Promise<number | null> {
    const result = await this.prisma.eventActivity.aggregate({
      where: { sport: { in: RUNNING_SPORTS }, event: { athleteId, startDate: { gte: new Date(Date.now() - 42 * DAY_MS), lte: new Date() } } },
      _max: { movingTime: true },
    });
    return result._max.movingTime;
  }

  private async gatherContext(athleteId: number): Promise<AthleteContext> {
    const [currentWeeklyVolume, availability, injuries, bestEfforts, zoneIds] =
      await Promise.all([
        this.recentWeeklyVolume(athleteId),
        this.fetchAvailability(athleteId),
        this.fetchOpenInjuries(athleteId),
        this.fetchBestEfforts(athleteId),
        this.fetchZoneIds(athleteId),
      ]);

    return {
      currentWeeklyVolume,
      availability,
      injuries,
      bestEfforts,
      zoneIds,
    };
  }

  private async fetchAvailability(
    athleteId: number,
  ): Promise<AvailabilitySlot[]> {
    const slots = await this.prisma.athleteAvailability.findMany({
      where: { athleteId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return slots.map((slot) => ({
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      priority: slot.priority,
    }));
  }

  private async fetchOpenInjuries(athleteId: number): Promise<InjurySignal[]> {
    const injuries = await this.prisma.athleteInjury.findMany({
      where: { athleteId, status: { not: 'RESOLVED' } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    return injuries.map((injury) => ({
      location: injury.location,
      // Stored normalized 0-1; the engine reasons on the 0-10 scale the
      // athlete actually reported, like every other RPE-style number in a plan.
      painScore: injury.painScore * 10,
      status: injury.status,
    }));
  }

  /**
   * Recent best efforts, derived from the athlete's speed records.
   * Records store an average speed over a distance, which converts directly
   * into the time the engine needs to compute VDOT.
   */
  private async fetchBestEfforts(athleteId: number): Promise<BestEffort[]> {
    const since = new Date(Date.now() - EFFORT_LOOKBACK_DAYS * DAY_MS);

    const records = await this.prisma.record.findMany({
      where: {
        athleteId,
        type: RecordType.SPEED,
        distance: { gte: MIN_EFFORT_DISTANCE_METERS },
        eventActivity: { sport: { in: RUNNING_SPORTS }, event: { startDate: { gte: since, lte: new Date() } } },
      },
      orderBy: { date: 'desc' },
      take: 50,
    });

    return records
      .filter((record) => record.value > 0)
      .map((record) => ({
        distanceMeters: record.distance,
        timeSeconds: record.value,
      }));
  }

  /**
   * Map training intensities onto the athlete's configured heart rate zones.
   *
   * Only used when there is no usable pace data at all: in that case a pace
   * target would be an invented number, while the athlete's own heart rate
   * zones are real. Whenever fitness can be resolved, absolute paces are more
   * precise and are preferred.
   */
  private async fetchZoneIds(
    athleteId: number,
  ): Promise<ZoneIdByIntensity | undefined> {
    const [metrics, zones] = await Promise.all([
      this.latestMetrics(athleteId),
      this.prisma.trainingZone.findMany({
        where: { athleteId, type: TRAINING_ZONE_TYPE.HEARTRATE },
        orderBy: { index: 'asc' },
      }),
    ]);

    const hasPaceData =
      Boolean(metrics[METRIC_TYPE.VMA]) || Boolean(metrics[METRIC_TYPE.VO2MAX]);

    if (hasPaceData || zones.length < 5) {
      return undefined;
    }

    const byIndex = new Map(
      zones.map((zone) => [zone.index, zone.trainingZoneId]),
    );

    const mapping: ZoneIdByIntensity = {
      [RunIntensity.RECOVERY]: byIndex.get(0),
      [RunIntensity.EASY]: byIndex.get(1),
      [RunIntensity.MARATHON]: byIndex.get(2),
      [RunIntensity.THRESHOLD]: byIndex.get(3),
      [RunIntensity.INTERVAL]: byIndex.get(4),
      [RunIntensity.REPETITION]: byIndex.get(4),
    };

    return mapping;
  }

  private async latestMetrics(
    athleteId: number,
  ): Promise<Partial<Record<METRIC_TYPE, number>>> {
    const metrics = await this.prisma.athleteMetric.findMany({
      where: { athleteId },
      orderBy: { date: 'desc' },
    });

    const latest: Partial<Record<METRIC_TYPE, number>> = {};

    for (const metric of metrics) {
      const type = metric.type as METRIC_TYPE;

      if (latest[type] === undefined) {
        latest[type] = metric.value;
      }
    }

    return latest;
  }
}

/** Sports a running plan can be generated for. */
export const SUPPORTED_PLAN_SPORTS: SPORT_TYPE[] = [
  SPORT_TYPE.RUNNING,
  SPORT_TYPE.TRAIL_RUNNING,
];
