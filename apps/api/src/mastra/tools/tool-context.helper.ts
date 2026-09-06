import { RuntimeContext } from '@mastra/core/runtime-context';

import { PrismaService } from 'src/modules/prisma/services/prisma.service';

/**
 * Tool context helpers
 *
 * Every coaching tool needs the same two things: a database handle and the id
 * of the athlete the conversation is about. Both are injected into the Mastra
 * runtime context by the caller (see createRuntimeContext in the agent
 * helpers), never supplied by the model - an agent must not be able to name
 * which athlete's data it reads.
 */

export interface ResolvedToolContext {
  prisma: PrismaService;
  athleteId: number;
}

export function resolveToolContext(
  runtimeContext: RuntimeContext | undefined,
): ResolvedToolContext {
  const prisma = runtimeContext?.get('prisma') as PrismaService | undefined;
  const athleteId = runtimeContext?.get('athleteId') as number | undefined;

  if (!prisma || typeof athleteId !== 'number') {
    throw new Error(
      'Tool called without an athlete context. This is a wiring bug, not something the athlete can fix.',
    );
  }

  return { prisma, athleteId };
}

/** Seconds to a compact "1h 20min" for the model to read back to the athlete. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) {
    return '0min';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  return hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;
}

/** Meters to kilometres, rounded to one decimal. */
export function toKilometers(meters: number | null | undefined): number | null {
  if (meters === null || meters === undefined) {
    return null;
  }

  return Math.round(meters / 100) / 10;
}

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
