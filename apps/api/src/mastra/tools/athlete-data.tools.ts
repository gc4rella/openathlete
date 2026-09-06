import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { PlanStatus } from '@openathlete/database';

import {
  DAY_NAMES,
  formatDuration,
  resolveToolContext,
  toKilometers,
} from './tool-context.helper';

/**
 * Athlete data tools
 *
 * These are the tools the coaching agents have always been instructed to call.
 * Until now the tools directory was empty, so every instruction to "fetch the
 * data before answering" was unsatisfiable and the agent had no choice but to
 * answer from nothing.
 *
 * All of them are read-only and scoped to the athlete in the runtime context.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const fetchActivitiesTool = createTool({
  id: 'fetch-activities',
  description:
    "Fetch the athlete's completed activities over a recent period. Use this for any question about what they have actually done: 'show me my runs', 'how many km last week', 'how did last month go'.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe('How many days back to look'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum number of activities to return, newest first'),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);
    const since = new Date(Date.now() - context.days * DAY_MS);

    const activities = await prisma.eventActivity.findMany({
      where: { event: { athleteId, startDate: { gte: since } } },
      orderBy: { event: { startDate: 'desc' } },
      take: context.limit,
      select: {
        eventActivityId: true,
        sport: true,
        distance: true,
        movingTime: true,
        elevationGain: true,
        averageHeartrate: true,
        rpe: true,
        description: true,
        event: { select: { name: true, startDate: true } },
      },
    });

    return {
      periodDays: context.days,
      count: activities.length,
      totalDistanceKm: toKilometers(
        activities.reduce((total, activity) => total + activity.distance, 0),
      ),
      totalDuration: formatDuration(
        activities.reduce((total, activity) => total + activity.movingTime, 0),
      ),
      activities: activities.map((activity) => ({
        id: activity.eventActivityId,
        name: activity.event.name,
        date: activity.event.startDate.toISOString().split('T')[0],
        sport: activity.sport,
        distanceKm: toKilometers(activity.distance),
        duration: formatDuration(activity.movingTime),
        elevationGainM: Math.round(activity.elevationGain),
        averageHeartrate: activity.averageHeartrate,
        // Stored 0-1; the athlete talks in 0-10.
        rpe: activity.rpe === null ? null : Math.round(activity.rpe * 10),
        notes: activity.description || null,
      })),
    };
  },
});

export const fetchAthleteAvailabilityTool = createTool({
  id: 'fetch-athlete-availability',
  description:
    "Fetch the athlete's declared weekly training windows. Use this for 'when can I train', 'what days am I free', or before suggesting a day to move a session to.",
  inputSchema: z.object({}),
  execute: async ({ runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);

    const slots = await prisma.athleteAvailability.findMany({
      where: { athleteId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return {
      configured: slots.length > 0,
      windows: slots.map((slot) => ({
        day: DAY_NAMES[slot.dayOfWeek],
        dayOfWeek: slot.dayOfWeek,
        from: slot.startTime,
        to: slot.endTime,
        priority: slot.priority,
      })),
    };
  },
});

export const fetchTrainingLoadTool = createTool({
  id: 'fetch-training-load',
  description:
    "Fetch the athlete's recent weekly training load. Use this for questions about fitness, fatigue, form, whether they are doing too much, or how a block is going.",
  inputSchema: z.object({
    weeks: z.number().int().min(1).max(26).default(8),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);
    const now = new Date();
    const since = new Date(now.getTime() - context.weeks * 7 * DAY_MS);

    const entries = await prisma.trainingLoadEntry.findMany({
      where: { calculation: { athleteId }, date: { gte: since } },
      select: { date: true, value: true },
      orderBy: { date: 'asc' },
    });

    const weekly = new Array<number>(context.weeks).fill(0);

    for (const entry of entries) {
      const weeksAgo = Math.floor(
        (now.getTime() - entry.date.getTime()) / (7 * DAY_MS),
      );

      if (weeksAgo >= 0 && weeksAgo < weekly.length) {
        weekly[weeksAgo] += entry.value;
      }
    }

    return {
      hasData: entries.length > 0,
      // Oldest first, so the model reads it as a progression.
      weeklyLoad: weekly
        .map((value, index) => ({
          weeksAgo: index,
          load: Math.round(value),
        }))
        .reverse(),
    };
  },
});

export const fetchTrainingPlanTool = createTool({
  id: 'fetch-training-plan',
  description:
    "Fetch the athlete's active training plan: its goal, phases, and where they currently are in it. Use this whenever they ask about their plan, their race, or what the next few weeks look like.",
  inputSchema: z.object({}),
  execute: async ({ runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);

    const plan = await prisma.trainingPlan.findFirst({
      where: { athleteId, status: PlanStatus.ACTIVE },
      orderBy: { startDate: 'desc' },
      include: {
        cycles: {
          orderBy: { startDate: 'asc' },
          include: { weeks: { orderBy: { weekNumber: 'asc' } } },
        },
        adjustments: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });

    if (!plan) {
      return { hasPlan: false as const };
    }

    const now = new Date();
    const weeks = plan.cycles.flatMap((cycle) =>
      cycle.weeks.map((week) => ({ ...week, phase: cycle.phase })),
    );
    const currentWeek = weeks.find(
      (week) => week.startDate <= now && week.endDate >= now,
    );

    return {
      hasPlan: true as const,
      name: plan.name,
      goal: plan.goal,
      raceDate: plan.raceDate?.toISOString().split('T')[0] ?? null,
      targetDistanceKm: toKilometers(plan.targetDistance),
      totalWeeks: weeks.length,
      currentWeek: currentWeek
        ? {
            weekNumber: currentWeek.weekNumber,
            phase: currentWeek.phase,
            theme: currentWeek.theme,
            targetVolume: formatDuration(currentWeek.targetVolume),
          }
        : null,
      phases: plan.cycles.map((cycle) => ({
        name: cycle.name,
        phase: cycle.phase,
        weeks: cycle.weeks.length,
      })),
      recentChanges: plan.adjustments.map((adjustment) => ({
        date: adjustment.createdAt.toISOString().split('T')[0],
        trigger: adjustment.trigger,
        reason: adjustment.reason,
      })),
    };
  },
});

export const fetchUpcomingSessionsTool = createTool({
  id: 'fetch-upcoming-sessions',
  description:
    "Fetch the athlete's planned sessions for the coming days, with their structure. Use this for 'what's my next session', 'what does this week look like', or before moving anything.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(60).default(14),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);
    const now = new Date();
    const until = new Date(now.getTime() + context.days * DAY_MS);

    const events = await prisma.event.findMany({
      where: {
        athleteId,
        startDate: { gte: now, lte: until },
        training: { isNot: null },
      },
      orderBy: { startDate: 'asc' },
      include: {
        training: {
          include: {
            workout: { include: { steps: { include: { targets: true } } } },
          },
        },
      },
    });

    return {
      count: events.length,
      sessions: events.map((event) => ({
        eventId: event.eventId,
        name: event.name,
        date: event.startDate.toISOString().split('T')[0],
        day: DAY_NAMES[event.startDate.getDay()],
        sport: event.training?.sport,
        duration: formatDuration(event.training?.goalDuration),
        distanceKm: toKilometers(event.training?.goalDistance),
        targetRpe:
          event.training?.goalRpe === null ||
          event.training?.goalRpe === undefined
            ? null
            : Math.round(event.training.goalRpe * 10),
        estimatedLoad: event.training?.estimatedLoad,
        description: event.training?.description,
        manuallyEdited: event.training?.manuallyEdited ?? false,
        completed: event.training?.relatedActivityId !== null,
        stepCount: event.training?.workout?.steps.length ?? 0,
      })),
    };
  },
});

export const fetchInjuriesTool = createTool({
  id: 'fetch-injuries',
  description:
    "Fetch the athlete's open injuries and niggles. Always check this before recommending anything hard, and use it when they mention pain or discomfort.",
  inputSchema: z.object({
    includeResolved: z.boolean().default(false),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);

    const injuries = await prisma.athleteInjury.findMany({
      where: {
        athleteId,
        ...(context.includeResolved ? {} : { status: { not: 'RESOLVED' } }),
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return {
      count: injuries.length,
      injuries: injuries.map((injury) => ({
        location: injury.location,
        // Stored 0-1; report on the 0-10 scale the athlete used.
        painScore: Math.round(injury.painScore * 10),
        status: injury.status,
        context: injury.context,
        reportedOn: injury.createdAt.toISOString().split('T')[0],
      })),
    };
  },
});

export const athleteDataTools = {
  'fetch-activities': fetchActivitiesTool,
  'fetch-athlete-availability': fetchAthleteAvailabilityTool,
  'fetch-training-load': fetchTrainingLoadTool,
  'fetch-training-plan': fetchTrainingPlanTool,
  'fetch-upcoming-sessions': fetchUpcomingSessionsTool,
  'fetch-injuries': fetchInjuriesTool,
};
