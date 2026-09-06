import { ZodValidationPipe } from 'nestjs-zod';

import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  CreateTemporaryPlanDto,
  ImportPlanBodyDto,
  SEOPlanData,
  createTemporaryPlanDtoSchema,
  importPlanBodyDtoSchema,
} from '@openathlete/shared';

import { JwtUser } from '../auth';
import { AuthUser } from '../auth/decorators/user.decorator';
import { TrainingPlanService } from '../coach/services/training-plan.service';
import { SeoPlanService } from './seo-plan.service';

@ApiTags('SEO Plan')
@Controller('seo-plan')
export class SeoPlanController {
  constructor(
    private readonly seoPlanService: SeoPlanService,
    private readonly trainingPlanService: TrainingPlanService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a temporary training plan',
    description:
      'Creates a temporary training plan that can be imported later. Returns a unique token that can be used to retrieve and import the plan. Plans expire after 7 days.',
  })
  @ApiBody({
    description: 'Training plan data',
    schema: {
      type: 'object',
      properties: {
        planData: {
          type: 'object',
          description: 'Structured training plan data',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Temporary plan created successfully',
    schema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          format: 'uuid',
          description: 'Unique token to retrieve and import the plan',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid plan data',
  })
  async createTemporaryPlan(
    @Body(new ZodValidationPipe(createTemporaryPlanDtoSchema))
    body: CreateTemporaryPlanDto,
  ): Promise<{ token: string }> {
    return this.seoPlanService.createTemporaryPlan(body.planData);
  }

  @Get(':token')
  @ApiOperation({
    summary: 'Get a temporary training plan',
    description:
      'Retrieves a temporary training plan by token. Public endpoint, no authentication required. Returns 404 if plan not found, expired, or already imported.',
  })
  @ApiParam({
    name: 'token',
    type: String,
    description: 'Unique token for the temporary plan',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan retrieved successfully',
    schema: {
      type: 'object',
      description: 'Structured training plan data',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Plan not found, expired, or already imported',
  })
  async getTemporaryPlan(@Param('token') token: string): Promise<SEOPlanData> {
    return this.seoPlanService.getTemporaryPlan(token);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Post(':token/import')
  @ApiOperation({
    summary: 'Import a temporary training plan',
    description:
      "Imports a temporary training plan into the authenticated user's account. Creates a TrainingPlan with all cycles, weeks, and events. Marks the temporary plan as imported.",
  })
  @ApiParam({
    name: 'token',
    type: String,
    description: 'Unique token for the temporary plan',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description:
      'Import parameters. The plan token is provided in the URL path.',
    schema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          format: 'date-time',
          description: 'Start date for the training plan',
        },
      },
      required: ['startDate'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Plan imported successfully',
    schema: {
      type: 'object',
      description: 'Created TrainingPlan with all cycles and events',
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or plan already imported',
  })
  @ApiResponse({
    status: 404,
    description: 'Plan not found or expired',
  })
  async importPlan(
    @JwtUser() user: AuthUser,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(importPlanBodyDtoSchema))
    body: ImportPlanBodyDto,
  ) {
    // Get the plan data
    const planData = await this.seoPlanService.getTemporaryPlan(token);

    // Import the plan
    const trainingPlan = await this.trainingPlanService.importPlan(
      user,
      planData,
      body.startDate,
    );

    // Mark as imported
    await this.seoPlanService.markAsImported(token);

    return trainingPlan;
  }
}
