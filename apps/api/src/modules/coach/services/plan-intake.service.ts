import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  type PlanIntakeMessage,
  type PlanIntakeResponse,
  planIntakeResponseSchema,
} from '@openathlete/shared';

import { ChatGptPlannerProviderService } from './chatgpt-planner-provider.service';
import { PlanGenerationService } from './plan-generation.service';
import { requiredIntakeFields } from './plan-intake.validation';

@Injectable()
export class PlanIntakeService {
  private readonly logger = new Logger(PlanIntakeService.name);

  constructor(
    private readonly generation: PlanGenerationService,
    private readonly provider: ChatGptPlannerProviderService,
  ) {}

  async reply(params: {
    athleteId: number;
    messages: PlanIntakeMessage[];
    language: 'EN' | 'FR' | 'IT';
    timeZone: string;
  }): Promise<PlanIntakeResponse> {
    const [weeklyVolume, recentLongestRun] = await Promise.all([
      this.generation.recentWeeklyVolume(params.athleteId),
      this.generation.recentLongestRun(params.athleteId),
    ]);

    const prompt = buildPrompt({
      ...params,
      weeklyVolume,
      recentLongestRun,
    });
    let result: PlanIntakeResponse;
    try {
      result = await this.provider.generate(prompt);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(
        `Plan intake failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadGatewayException('AI_PLAN_INTAKE_FAILED');
    }

    const response = planIntakeResponseSchema.parse(result);
    const missingFields = requiredIntakeFields(response.draft);

    return {
      ...response,
      // Model output is advisory. Readiness is recomputed in code before the
      // UI is allowed to proceed to deterministic generation.
      ready: missingFields.length === 0,
      missingFields,
    };
  }
}

function buildPrompt(params: {
  messages: PlanIntakeMessage[];
  language: 'EN' | 'FR' | 'IT';
  timeZone: string;
  weeklyVolume: number | null;
  recentLongestRun: number | null;
}): string {
  return `Conduct the training-plan intake.

CURRENT CONTEXT:
${JSON.stringify(
  {
    today: calendarDateInTimeZone(new Date(), params.timeZone),
    language: params.language,
    timeZone: params.timeZone,
    knownAthleteData: {
      currentWeeklyVolumeSeconds: params.weeklyVolume,
      recentLongestRunSeconds: params.recentLongestRun,
    },
  },
  null,
  2,
)}

CONVERSATION:
${JSON.stringify(params.messages, null, 2)}

If the conversation is empty, introduce yourself in one sentence and ask the first one or two useful questions.`;
}

function calendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}
