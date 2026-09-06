import { BadRequestException, Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { SportType } from '@openathlete/database';
import { z } from 'zod';
import { AuthUser, JwtUser } from '../../auth/decorators/user.decorator';
import { ActivityFileImportService } from '../services/activity-file-import.service';

type Upload = { buffer: Buffer; originalname: string };
const selectionSchema = z.array(z.object({ fingerprint: z.string().max(100), sport: z.nativeEnum(SportType) })).max(1000);

@ApiTags('Activity import')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('activity-files')
export class ActivityFileImportController {
  constructor(private readonly importer: ActivityFileImportService) {}

  @Post('preview')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  preview(@JwtUser() user: AuthUser, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException('Select an activity file');
    return this.importer.process(user, file.buffer, file.originalname);
  }

  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  import(@JwtUser() user: AuthUser, @UploadedFile() file: Upload | undefined, @Body('selection') selection: string) {
    if (!file) throw new BadRequestException('Select an activity file');
    let parsed;
    try { parsed = selectionSchema.parse(JSON.parse(selection)); }
    catch { throw new BadRequestException('Invalid activity selection'); }
    return this.importer.process(user, file.buffer, file.originalname, parsed);
  }
}
