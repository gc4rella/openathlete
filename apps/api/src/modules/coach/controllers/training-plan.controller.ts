import { ZodValidationPipe } from 'nestjs-zod';

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  type CreateTrainingPlanDto,
  type PreviewTrainingPlanDto,
  type UpdateTrainingPlanDto,
  createTrainingPlanDtoSchema,
  previewTrainingPlanDtoSchema,
  updateTrainingPlanDtoSchema,
} from '@openathlete/shared';

import { JwtUser, UserTypeGuard } from 'src/modules/auth';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { TrainingPlanService } from '../services/training-plan.service';

@ApiTags('Training Plan')
@Controller('training-plan')
export class TrainingPlanController {
  constructor(private readonly trainingPlanService: TrainingPlanService) {}

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Post('preview')
  @ApiOperation({
    summary: 'Preview a generated training plan without saving it',
    description:
      "Runs the deterministic plan generation engine and returns the resulting plan without writing anything to the database. Used by the plan wizard so the athlete can review and re-roll a plan before committing to it. The engine derives training paces from the athlete's own metrics (VMA, VO2max, heart rate) and personal records, starts the volume ramp from the athlete's real recent training volume, places sessions according to their declared availability, and respects any open injuries. The response also includes the resolved fitness (VDOT and where it came from), the predicted race time, and the planned weekly training load.",
  })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description:
      'Generate for a coached athlete instead of the caller. The caller must be coaching that athlete.',
  })
  @ApiBody({ description: 'Plan generation input (the wizard answers)' })
  @ApiResponse({
    status: 201,
    description: 'Generated plan, fitness assessment and weekly load curve',
  })
  @ApiResponse({ status: 400, description: 'Invalid generation input' })
  @ApiResponse({ status: 403, description: 'Not coaching this athlete' })
  async preview(
    @JwtUser() user: AuthUser,
    @Body(new ZodValidationPipe(previewTrainingPlanDtoSchema))
    body: PreviewTrainingPlanDto,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.trainingPlanService.preview(
      user,
      body.input,
      parseAthleteId(athleteId),
      body.skipNarrative,
    );
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Post()
  @ApiOperation({
    summary: 'Generate and save a training plan',
    description:
      "Generates a plan with the same engine as the preview endpoint and writes it to the database as a TrainingPlan with its cycles, weeks and training sessions. Sessions become ordinary calendar events, so they appear in the calendar and are exported to connected watches like any other planned workout. Pass activate=true to make the plan the athlete's active plan; any previously active plan is archived, because the adaptation engine adjusts exactly one plan. The full generation input is stored on the plan so it can be reproduced or regenerated later.",
  })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description: 'Create the plan for a coached athlete instead of the caller.',
  })
  @ApiBody({ description: 'Plan generation input plus creation options' })
  @ApiResponse({
    status: 201,
    description: 'Created training plan with all cycles, weeks and sessions',
  })
  @ApiResponse({ status: 400, description: 'Invalid generation input' })
  @ApiResponse({ status: 403, description: 'Not coaching this athlete' })
  async create(
    @JwtUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTrainingPlanDtoSchema))
    body: CreateTrainingPlanDto,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.trainingPlanService.create(
      user,
      body,
      parseAthleteId(athleteId),
    );
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get()
  @ApiOperation({
    summary: 'List training plans',
    description:
      'Returns every training plan the authenticated user can see, most relevant first (active plans before drafts and archives, then newest). Coaches see the plans of the athletes they coach. Each plan includes counts of its cycles and adjustments but not the full session tree; fetch a single plan for that.',
  })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description: 'Filter to a single athlete.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of accessible training plans',
  })
  async findMany(
    @JwtUser() user: AuthUser,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.trainingPlanService.findMany(user, parseAthleteId(athleteId));
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get('current')
  @ApiOperation({
    summary: 'Get the active training plan',
    description:
      "Returns the athlete's currently active plan with its full structure (cycles, weeks, sessions and structured workouts), or null if they have no active plan. This is what the dashboard and the 'today's session' card read.",
  })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description: 'Read a coached athlete instead of the caller.',
  })
  @ApiResponse({
    status: 200,
    description: 'The active plan, or null when there is none',
  })
  async findCurrent(
    @JwtUser() user: AuthUser,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.trainingPlanService.findCurrent(
      user,
      parseAthleteId(athleteId),
    );
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get(':trainingPlanId')
  @ApiOperation({
    summary: 'Get a training plan',
    description:
      'Returns one training plan with its cycles, weeks, sessions, structured workouts and its adjustment history.',
  })
  @ApiParam({ name: 'trainingPlanId', type: Number })
  @ApiResponse({ status: 200, description: 'The training plan' })
  @ApiResponse({ status: 404, description: 'Plan not found or not accessible' })
  async findOne(
    @JwtUser() user: AuthUser,
    @Param('trainingPlanId', ParseIntPipe) trainingPlanId: number,
  ) {
    return this.trainingPlanService.findOne(user, trainingPlanId);
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get(':trainingPlanId/adjustments')
  @ApiOperation({
    summary: 'List the changes made to a plan',
    description:
      "Returns the plan's adjustment history, newest first: every automatic change the adaptation engine made and every manual change, each with the trigger that caused it, a human-readable reason and a structured diff. This is what the 'why did my plan change?' feed shows.",
  })
  @ApiParam({ name: 'trainingPlanId', type: Number })
  @ApiResponse({ status: 200, description: 'Adjustment history' })
  @ApiResponse({ status: 404, description: 'Plan not found or not accessible' })
  async findAdjustments(
    @JwtUser() user: AuthUser,
    @Param('trainingPlanId', ParseIntPipe) trainingPlanId: number,
  ) {
    return this.trainingPlanService.findAdjustments(user, trainingPlanId);
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Patch(':trainingPlanId')
  @ApiOperation({
    summary: 'Rename a plan or change its status',
    description:
      'Updates the plan name, description or status. Setting the status to ACTIVE archives any other active plan for the same athlete, since exactly one plan is adapted at a time.',
  })
  @ApiParam({ name: 'trainingPlanId', type: Number })
  @ApiBody({ description: 'Fields to update' })
  @ApiResponse({ status: 200, description: 'The updated plan' })
  @ApiResponse({ status: 404, description: 'Plan not found or not accessible' })
  async update(
    @JwtUser() user: AuthUser,
    @Param('trainingPlanId', ParseIntPipe) trainingPlanId: number,
    @Body(new ZodValidationPipe(updateTrainingPlanDtoSchema))
    body: UpdateTrainingPlanDto,
  ) {
    return this.trainingPlanService.update(user, trainingPlanId, body);
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Delete(':trainingPlanId')
  @ApiOperation({
    summary: 'Delete a training plan',
    description:
      'Deletes the plan along with its cycles, weeks and any sessions that were never completed. Sessions the athlete actually did are kept and simply detached from the plan: completed training is real history and must outlive the plan that suggested it.',
  })
  @ApiParam({ name: 'trainingPlanId', type: Number })
  @ApiResponse({ status: 200, description: 'Plan deleted' })
  @ApiResponse({ status: 404, description: 'Plan not found or not accessible' })
  async remove(
    @JwtUser() user: AuthUser,
    @Param('trainingPlanId', ParseIntPipe) trainingPlanId: number,
  ) {
    return this.trainingPlanService.remove(user, trainingPlanId);
  }
}

function parseAthleteId(value?: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isNaN(parsed) ? undefined : parsed;
}
