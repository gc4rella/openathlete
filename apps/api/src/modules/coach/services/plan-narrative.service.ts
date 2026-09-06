import { z } from 'zod';

import { Injectable, Logger } from '@nestjs/common';

import { FeatureName, type GeneratedPlanData } from '@openathlete/shared';

import { planNarrativeAgent } from 'src/mastra/agents';
import { FeatureAccessService } from 'src/modules/subscription';

/**
 * Plan narrative
 *
 * Optional pass that replaces the engine's templated prose with something
 * written for this specific athlete.
 *
 * Three properties are load bearing:
 *
 *  1. **It cannot change the training.** The agent returns a patch keyed by
 *     week number and day of week, never a plan. Durations, paces, targets and
 *     loads are copied across untouched because they are never handed to the
 *     model in a writable form.
 *  2. **It is optional.** If no AI provider is configured, or the athlete's
 *     plan does not include AI features, or the call fails, generation
 *     continues with the deterministic prose. A self-hosted instance with no
 *     API key still produces a complete plan.
 *  3. **It is bounded.** One call per plan, with a timeout.
 */

const NARRATIVE_TIMEOUT_MS = 60_000;

const narrativeSchema = z.object({
  planName: z.string().min(1).max(120),
  planDescription: z.string().min(1).max(1200),
  coachNotes: z.string().min(1).max(2000),
  cycles: z
    .array(
      z.object({
        index: z.number().int().min(0),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(600),
      }),
    )
    .default([]),
  weeks: z
    .array(
      z.object({
        weekNumber: z.number().int().min(1),
        theme: z.string().min(1).max(80),
      }),
    )
    .default([]),
  sessions: z
    .array(
      z.object({
        weekNumber: z.number().int().min(1),
        dayOfWeek: z.number().int().min(0).max(6),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(600),
      }),
    )
    .default([]),
});

type Narrative = z.infer<typeof narrativeSchema>;

@Injectable()
export class PlanNarrativeService {
  private readonly logger = new Logger(PlanNarrativeService.name);

  constructor(private readonly featureAccess: FeatureAccessService) {}

  /**
   * Rewrite a plan's prose, or return it unchanged if that is not possible.
   * Never throws: prose is a nice-to-have, the plan is not.
   */
  async embellish(
    userId: number,
    plan: GeneratedPlanData,
    language: 'EN' | 'FR' | 'IT',
  ): Promise<GeneratedPlanData> {
    if (!(await this.isAvailable(userId))) {
      return plan;
    }

    try {
      const narrative = await this.requestNarrative(plan, language);

      return narrative ? applyNarrative(plan, narrative) : plan;
    } catch (error) {
      this.logger.warn(
        `Plan narrative pass failed, keeping generated prose: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return plan;
    }
  }

  private async isAvailable(userId: number): Promise<boolean> {
    // No provider configured: a self-hosted instance without an API key.
    if (!hasAiProvider()) {
      return false;
    }

    try {
      return await this.featureAccess.canAccessFeature(
        userId,
        FeatureName.AI_GENERATION,
      );
    } catch {
      return false;
    }
  }

  private async requestNarrative(
    plan: GeneratedPlanData,
    language: 'EN' | 'FR' | 'IT',
  ): Promise<Narrative | null> {
    const result = await withTimeout(
      planNarrativeAgent.generate(buildPrompt(plan, language), {
        structuredOutput: { schema: narrativeSchema },
      }),
      NARRATIVE_TIMEOUT_MS,
    );

    return result?.object ?? null;
  }
}

/**
 * A read-only summary of the plan.
 *
 * Deliberately excludes workout steps and pace targets: the agent does not
 * need them to describe a session, and anything it is not shown is something
 * it cannot contradict.
 */
function buildPrompt(
  plan: GeneratedPlanData,
  language: 'EN' | 'FR' | 'IT',
): string {
  const summary = {
    language,
    goal: plan.plan.goal,
    durationWeeks: plan.plan.duration,
    distanceMeters: plan.plan.distance || null,
    timeTargetSeconds: plan.plan.timeTarget ?? null,
    cycles: plan.cycles.map((cycle, index) => ({
      index,
      phase: cycle.phase,
      weeks: cycle.weeks.map((week) => ({
        weekNumber: week.weekNumber,
        isRecovery: week.theme?.toLowerCase().includes('recover') ?? false,
        totalMinutes: Math.round((week.targetVolume ?? 0) / 60),
        sessions: week.sessions.map((session) => ({
          dayOfWeek: session.dayOfWeek,
          archetype: session.archetype,
          minutes: Math.round((session.goalDuration ?? 0) / 60),
          rpe: session.goalRpe,
        })),
      })),
    })),
  };

  return `Write the coaching prose for this training plan.

Respond in ${language}.

PLAN:
${JSON.stringify(summary, null, 2)}`;
}

/**
 * Apply the patch. Only prose fields are assigned; every numeric field is
 * carried over by construction, so there is nothing for a bad response to
 * corrupt. Entries referencing weeks or sessions that do not exist are
 * ignored rather than rejected, so one bad reference does not cost the whole
 * narrative.
 */
function applyNarrative(
  plan: GeneratedPlanData,
  narrative: Narrative,
): GeneratedPlanData {
  const weekThemes = new Map(
    narrative.weeks.map((week) => [week.weekNumber, week.theme]),
  );
  const cycleText = new Map(
    narrative.cycles.map((cycle) => [cycle.index, cycle]),
  );
  const sessionText = new Map(
    narrative.sessions.map((session) => [
      `${session.weekNumber}:${session.dayOfWeek}`,
      session,
    ]),
  );

  return {
    plan: {
      ...plan.plan,
      name: narrative.planName,
      description: narrative.planDescription,
      coachNotes: narrative.coachNotes,
    },
    cycles: plan.cycles.map((cycle, index) => {
      const text = cycleText.get(index);

      return {
        ...cycle,
        name: text?.name ?? cycle.name,
        description: text?.description ?? cycle.description,
        weeks: cycle.weeks.map((week) => ({
          ...week,
          theme: weekThemes.get(week.weekNumber) ?? week.theme,
          sessions: week.sessions.map((session) => {
            const text = sessionText.get(
              `${week.weekNumber}:${session.dayOfWeek}`,
            );

            return {
              ...session,
              name: text?.name ?? session.name,
              description: text?.description ?? session.description,
            };
          }),
        })),
      };
    }),
  };
}

/** Whether any LLM provider credential is configured. */
function hasAiProvider(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.OPENROUTER_API_KEY,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
