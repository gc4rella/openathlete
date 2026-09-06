import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth';
import { CoachModule } from '../coach/coach.module';
import { PrismaService } from '../prisma/services/prisma.service';
import { SeoPlanController } from './seo-plan.controller';
import { SeoPlanService } from './seo-plan.service';

@Module({
  imports: [AuthModule, forwardRef(() => CoachModule)],
  controllers: [SeoPlanController],
  providers: [SeoPlanService, PrismaService],
  exports: [SeoPlanService],
})
export class SeoPlanModule {}
