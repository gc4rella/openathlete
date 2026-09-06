import { ZodValidationPipe } from 'nestjs-zod';

import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  type SetAthleteAvailabilityDto,
  setAthleteAvailabilityDtoSchema,
} from '@openathlete/shared';

import { JwtUser, UserTypeGuard } from 'src/modules/auth';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { AthleteAvailabilityService } from '../services/athlete-availability.service';

@ApiTags('Athlete Availability')
@Controller('athlete-availability')
export class AthleteAvailabilityController {
  constructor(private readonly availability: AthleteAvailabilityService) {}

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get()
  @ApiOperation({
    summary: "Get the athlete's weekly availability",
    description:
      'Returns the training windows the athlete declared for each day of the week, ordered by day then start time. The plan generator uses these to decide which days to train on, which day carries the long run, and what time of day sessions are scheduled for.',
  })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description: 'Read a coached athlete instead of the caller.',
  })
  @ApiResponse({ status: 200, description: 'Weekly availability windows' })
  @ApiResponse({ status: 403, description: 'Not coaching this athlete' })
  async find(
    @JwtUser() user: AuthUser,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.availability.find(user, parseAthleteId(athleteId));
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Put()
  @ApiOperation({
    summary: "Replace the athlete's weekly availability",
    description:
      'Replaces the whole weekly schedule with the supplied windows. This is a full replacement rather than a partial update because the wizard always submits the complete week, which avoids leaving a half-updated schedule behind. Overlapping windows on the same day are rejected. Days with a HIGH priority window are preferred when placing long and quality sessions.',
  })
  @ApiBody({ description: 'The complete set of weekly availability windows' })
  @ApiQuery({
    name: 'athleteId',
    type: Number,
    required: false,
    description: 'Update a coached athlete instead of the caller.',
  })
  @ApiResponse({ status: 200, description: 'The stored availability windows' })
  @ApiResponse({
    status: 400,
    description: 'Overlapping or malformed availability windows',
  })
  @ApiResponse({ status: 403, description: 'Not coaching this athlete' })
  async set(
    @JwtUser() user: AuthUser,
    @Body(new ZodValidationPipe(setAthleteAvailabilityDtoSchema))
    body: SetAthleteAvailabilityDto,
    @Query('athleteId') athleteId?: string,
  ) {
    return this.availability.set(user, body, parseAthleteId(athleteId));
  }
}

function parseAthleteId(value?: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isNaN(parsed) ? undefined : parsed;
}
