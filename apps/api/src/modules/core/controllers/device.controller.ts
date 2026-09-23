import { ZodValidationPipe } from 'nestjs-zod';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  type DeviceSessionDto,
  deviceSessionSchema,
} from '@openathlete/shared';

import { AuthUser, JwtUser } from '../../auth/decorators/user.decorator';
import { DeviceService } from '../services/device.service';

@ApiTags('Device')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('device')
export class DeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Get('workouts')
  @ApiOperation({
    summary: 'Planned runs ready for real-time coaching on a watch',
    description:
      "Returns the authenticated athlete's planned running sessions in [from, to) (max 31 days). Repeat blocks are expanded and every target is resolved to absolute units: pace in seconds per kilometer, heart rate in bpm. Zone targets use the athlete's training zones; relative targets use the latest metrics. Targets that cannot be coached live become instruction text and are listed in warnings.",
  })
  @ApiQuery({ name: 'from', type: String, example: '2026-09-23T00:00:00.000Z' })
  @ApiQuery({ name: 'to', type: String, example: '2026-10-07T00:00:00.000Z' })
  @ApiResponse({ status: 200, description: 'Device workouts, oldest first' })
  workouts(
    @JwtUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.devices.workouts(user, new Date(from), new Date(to));
  }

  @Post('sessions')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload a run recorded on the watch or phone',
    description:
      'Creates an activity with its stream and one WORKOUT_STEP segment per executed step, linked to the planned session when eventId is given. Idempotent on clientId: retries return status "duplicate". The activity then goes through the regular processing pipeline (normalization, training load, feedback).',
  })
  @ApiBody({ description: 'Recorded session' })
  @ApiResponse({ status: 200, description: 'Imported or already present' })
  @ApiResponse({ status: 404, description: 'Planned session not found' })
  ingest(
    @JwtUser() user: AuthUser,
    @Body(new ZodValidationPipe(deviceSessionSchema)) body: DeviceSessionDto,
  ) {
    return this.devices.ingest(user, body);
  }
}
