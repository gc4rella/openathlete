import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { PlanAdjustmentTrigger, Prisma } from '@openathlete/database';

import { DAY_NAMES, resolveToolContext } from './tool-context.helper';

/**
 * Session management tools
 *
 * The small number of changes it is safe to let a conversation make.
 *
 * Both write tools:
 *  - refuse to touch a session that has already been completed;
 *  - mark the session `manuallyEdited`, so the automatic adaptation engine
 *    will not later overwrite a decision the athlete made in conversation;
 *  - record a MANUAL adjustment against the plan, so the change shows up in
 *    the same "why did my plan change?" feed as the automatic ones.
 *
 * They deliberately cannot change a session's *content* - durations, targets
 * and intensities stay as the deterministic engine computed them. Rescheduling
 * is a calendar decision; prescribing is not.
 */

const MAX_MOVE_DAYS = 14;

export const moveSessionTool = createTool({
  id: 'move-session',
  description:
    "Move a planned training session to a different date, keeping the workout exactly as it is. Use when the athlete says something like 'move Thursday's session to Friday'. Call fetch-upcoming-sessions first to get the eventId.",
  inputSchema: z.object({
    eventId: z.number().int().describe('The session to move'),
    newDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Target date in YYYY-MM-DD format'),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);

    const event = await prisma.event.findFirst({
      where: { eventId: context.eventId, athleteId },
      include: { training: true, trainingWeek: true },
    });

    if (!event || !event.training) {
      return {
        moved: false,
        reason: 'That session does not exist, or does not belong to you.',
      };
    }

    if (event.training.relatedActivityId !== null) {
      return {
        moved: false,
        reason:
          'That session has already been completed, so it cannot be moved.',
      };
    }

    const target = new Date(`${context.newDate}T00:00:00`);

    if (Number.isNaN(target.getTime())) {
      return { moved: false, reason: 'That date could not be understood.' };
    }

    const now = new Date();

    if (target < startOfDay(now)) {
      return {
        moved: false,
        reason: 'Sessions cannot be moved into the past.',
      };
    }

    if (target.getTime() - now.getTime() > MAX_MOVE_DAYS * 86400000) {
      return {
        moved: false,
        reason: `Sessions can only be moved up to ${MAX_MOVE_DAYS} days ahead.`,
      };
    }

    // Keep the time of day the athlete already trains at.
    const newStart = new Date(target);
    newStart.setHours(
      event.startDate.getHours(),
      event.startDate.getMinutes(),
      0,
      0,
    );

    const durationMs = event.endDate.getTime() - event.startDate.getTime();
    const previousStart = event.startDate;

    await prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { eventId: event.eventId },
        data: {
          startDate: newStart,
          endDate: new Date(newStart.getTime() + durationMs),
        },
      });

      await tx.eventTraining.update({
        where: { eventTrainingId: event.training!.eventTrainingId },
        data: { manuallyEdited: true },
      });

      await recordManualAdjustment(tx, {
        trainingWeekId: event.trainingWeekId,
        kind: 'SESSION_MOVED',
        eventId: event.eventId,
        reason: `You moved "${event.name}" from ${formatDate(previousStart)} to ${formatDate(newStart)}.`,
        before: { date: previousStart.toISOString() },
        after: { date: newStart.toISOString() },
      });
    });

    return {
      moved: true,
      session: event.name,
      from: `${DAY_NAMES[previousStart.getDay()]} ${formatDate(previousStart)}`,
      to: `${DAY_NAMES[newStart.getDay()]} ${formatDate(newStart)}`,
    };
  },
});

export const skipSessionTool = createTool({
  id: 'skip-session',
  description:
    'Remove a planned session the athlete has decided not to do. Use only when they clearly say they want to skip or drop it. Call fetch-upcoming-sessions first to get the eventId.',
  inputSchema: z.object({
    eventId: z.number().int(),
    reason: z
      .string()
      .max(200)
      .optional()
      .describe("The athlete's reason, in their own words, if they gave one"),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { prisma, athleteId } = resolveToolContext(runtimeContext);

    const event = await prisma.event.findFirst({
      where: { eventId: context.eventId, athleteId },
      include: { training: { include: { workout: true } } },
    });

    if (!event || !event.training) {
      return {
        skipped: false,
        reason: 'That session does not exist, or does not belong to you.',
      };
    }

    if (event.training.relatedActivityId !== null) {
      return {
        skipped: false,
        reason:
          'That session has already been completed, so there is nothing to skip.',
      };
    }

    await prisma.$transaction(async (tx) => {
      await recordManualAdjustment(tx, {
        trainingWeekId: event.trainingWeekId,
        kind: 'SESSION_REMOVED',
        eventId: event.eventId,
        reason: context.reason
          ? `You skipped "${event.name}": ${context.reason}`
          : `You skipped "${event.name}".`,
        before: {
          name: event.name,
          date: event.startDate.toISOString(),
          goalDuration: event.training?.goalDuration,
        },
        after: null,
      });

      if (event.training?.workout) {
        await tx.workout.delete({
          where: { workoutId: event.training.workout.workoutId },
        });
      }

      await tx.eventTraining.delete({
        where: { eventTrainingId: event.training!.eventTrainingId },
      });
      await tx.event.delete({ where: { eventId: event.eventId } });
    });

    return { skipped: true, session: event.name };
  },
});

/**
 * Record a manual change against the plan the session belongs to, so it shows
 * up alongside the automatic adjustments. Sessions outside a plan are simply
 * not recorded - there is nothing to attach the change to.
 */
async function recordManualAdjustment(
  tx: Prisma.TransactionClient,
  params: {
    trainingWeekId: number | null;
    kind: string;
    eventId: number;
    reason: string;
    before: unknown;
    after: unknown;
  },
) {
  if (params.trainingWeekId === null) {
    return;
  }

  const week = await tx.trainingWeek.findUnique({
    where: { trainingWeekId: params.trainingWeekId },
    select: { cycle: { select: { trainingPlanId: true } } },
  });

  const trainingPlanId = week?.cycle.trainingPlanId;

  if (!trainingPlanId) {
    return;
  }

  await tx.trainingPlanAdjustment.create({
    data: {
      trainingPlanId,
      trainingWeekId: params.trainingWeekId,
      trigger: PlanAdjustmentTrigger.MANUAL,
      reason: params.reason,
      changes: [
        {
          eventId: params.eventId,
          trainingWeekId: params.trainingWeekId,
          kind: params.kind,
          before: params.before,
          after: params.after,
        },
      ] as unknown as Prisma.InputJsonValue,
      automatic: false,
    },
  });
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export const sessionManagementTools = {
  'move-session': moveSessionTool,
  'skip-session': skipSessionTool,
};
