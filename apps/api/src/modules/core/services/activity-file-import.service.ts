import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventActivity, Prisma, SportType } from '@openathlete/database';
import { type ActivityStream } from '@openathlete/shared';
import { ActivityImportedEvent } from 'src/events';
import { AuthUser } from '../../auth/decorators/user.decorator';
import { PrismaService } from '../../prisma/services/prisma.service';
import { type ImportedFileActivity, parseImportFile } from '../helpers/activity-file-import';
import { compressActivityStream, uncompressActivityStream } from '../helpers/activity-stream';
import { computeRecords } from '../helpers/record';
import { TrainingMatchProcessor } from './pipeline/processors/training-match.processor';

export type ImportSelection = { fingerprint: string; sport: SportType };
type FileMetadata = { fingerprints?: string[]; sourceFiles?: string[]; samples?: unknown[]; processingComplete?: boolean };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const mean = (values?: number[]) => values?.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const max = (values?: number[]) => values?.length ? values.reduce((a,b) => Math.max(a,b), -Infinity) : null;
const score = (stream: ActivityStream) => Object.values(stream).reduce((sum, values) => sum + (values?.length ?? 0), 0);

export function sameActivity(existing: { distance: number; movingTime: number }, incoming: { distance: number; movingTime: number }): boolean {
  return incoming.distance > 0 && Math.abs(existing.distance - incoming.distance) <= Math.max(30, incoming.distance * 0.02)
    && Math.abs(existing.movingTime - incoming.movingTime) <= Math.max(5, incoming.movingTime * 0.03);
}

@Injectable()
export class ActivityFileImportService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2, private readonly matcher: TrainingMatchProcessor) {}

  private athleteId(user: AuthUser): number {
    if (!user.athlete?.athleteId) throw new BadRequestException('An athlete profile is required');
    return user.athlete.athleteId;
  }

  private async findExisting(db: Prisma.TransactionClient, athleteId: number, incoming: ImportedFileActivity) {
    const exact = await db.eventActivity.findFirst({ where: { event: { athleteId }, OR: [
      { externalId: `file:${athleteId}:${incoming.fingerprint}` },
      { importMetadata: { path: ['fingerprints'], array_contains: incoming.fingerprint } },
    ] }, include: { event: true, segments: true } });
    if (exact) return exact;
    const candidates = await db.eventActivity.findMany({ where: {
      sport: incoming.sport, event: { athleteId, startDate: { gte: new Date(incoming.startDate.getTime() - 3000), lte: new Date(incoming.startDate.getTime() + 3000) } },
    }, include: { event: true, segments: true }, take: 20 });
    const matches = candidates.filter(existing => sameActivity(existing, incoming));
    return matches.length === 1 ? matches[0] : null;
  }

  async process(user: AuthUser, buffer: Buffer, filename: string, selection?: ImportSelection[]) {
    const athleteId = this.athleteId(user);
    let parsed;
    try { parsed = parseImportFile(buffer, filename); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Cannot read file'); }
    const results = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      const incoming = row.activity;
      if (!incoming) { results.push({ sourceFile: row.sourceFile, status: 'error', error: row.error }); continue; }
      const chosen = selection?.find(item => item.fingerprint === incoming.fingerprint);
      if (selection && !chosen) continue;
      if (chosen) incoming.sport = chosen.sport;
      const summary = { sourceFile: row.sourceFile, fingerprint: incoming.fingerprint, name: incoming.name, sport: incoming.sport,
        startDate: incoming.startDate, distance: incoming.distance, movingTime: incoming.movingTime,
        elapsedTime: (incoming.endDate.getTime() - incoming.startDate.getTime()) / 1000,
        warnings: incoming.warnings, format: incoming.format };
      if (seen.has(incoming.fingerprint)) { results.push({ ...summary, status: 'duplicate' }); continue; }
      seen.add(incoming.fingerprint);
      try {
        if (!selection) {
          const existing = await this.findExisting(this.prisma, athleteId, incoming);
          const metadata = existing?.importMetadata as FileMetadata | null;
          results.push({ ...summary, status: metadata?.fingerprints?.includes(incoming.fingerprint) ? 'duplicate' : existing ? 'merge' : 'ready' });
          continue;
        }
        const saved = await this.prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${athleteId})`;
          const existing = await this.findExisting(tx, athleteId, incoming);
          const metadata = existing?.importMetadata as FileMetadata | null;
          if (metadata?.fingerprints?.includes(incoming.fingerprint)) return { activity: existing!, status: 'duplicate', complete: metadata.processingComplete === true };
          const existingStream = existing?.stream ? uncompressActivityStream(existing.stream as Parameters<typeof uncompressActivityStream>[0]) : null;
          const richer = !existingStream || score(incoming.stream) > score(existingStream);
          const stream = richer ? incoming.stream : existingStream;
          const elevationGain = (stream.altitude ?? []).reduce((sum, v, i, values) => sum + (i > 0 ? Math.max(0, v - values[i - 1]) : 0), 0);
          const importedData = {
            stream: json(compressActivityStream(stream)),
            ...(richer ? { averageHeartrate: mean(stream.heartrate), maxHeartrate: max(stream.heartrate), averageCadence: mean(stream.cadence), averageWatts: mean(stream.watts), maxWatts: max(stream.watts), elevationGain } : {}),
            importMetadata: json({ ...metadata, fingerprints: [...(metadata?.fingerprints ?? []), incoming.fingerprint], sourceFiles: [...(metadata?.sourceFiles ?? []), incoming.sourceFile],
              samples: richer ? incoming.samples : metadata?.samples, warnings: incoming.warnings, format: incoming.format, processingComplete: false }),
          };
          let activity: EventActivity;
          if (existing) activity = await tx.eventActivity.update({ where: { eventActivityId: existing.eventActivityId }, data: importedData });
          else {
            const event = await tx.event.create({ data: { athleteId, name: incoming.name, type: 'ACTIVITY', startDate: incoming.startDate, endDate: incoming.endDate,
              activity: { create: { ...importedData, sport: incoming.sport, externalId: `file:${athleteId}:${incoming.fingerprint}`, distance: incoming.distance,
                movingTime: incoming.movingTime, averageSpeed: incoming.distance / incoming.movingTime, maxSpeed: incoming.distance / incoming.movingTime, elevationGain,
                description: '' } } }, include: { activity: true } });
            activity = event.activity!;
          }
          if (!existing || richer) {
            await tx.record.deleteMany({ where: { eventActivityId: activity.eventActivityId } });
            const records = computeRecords(stream);
            if (records.length) await tx.record.createMany({ data: records.map(record => ({ ...record, athleteId, eventActivityId: activity.eventActivityId, date: existing?.event.startDate ?? incoming.startDate })) });
          }
          if (incoming.laps.length && (!existing || existing.segments.length === 0)) await tx.activitySegment.createMany({ data: incoming.laps.map(lap => ({ ...lap, segmentType: 'LAP', eventActivityId: activity.eventActivityId })) });
          return { activity, status: existing ? 'merged' : 'imported', complete: false };
        }, { timeout: 60000 });
        if (!saved.complete) {
          await this.matcher.run({ eventActivityId: saved.activity.eventActivityId, eventId: saved.activity.eventId, bulkImport: true });
          // Bulk mode calculates history but skips paid AI and per-activity adaptation.
          await this.events.emitAsync(ActivityImportedEvent.SLUG, new ActivityImportedEvent({ eventActivityId: saved.activity.eventActivityId, eventId: saved.activity.eventId, bulkImport: true }));
          const stored = await this.prisma.eventActivity.findUniqueOrThrow({ where: { eventActivityId: saved.activity.eventActivityId }, select: { importMetadata: true } });
          await this.prisma.eventActivity.update({ where: { eventActivityId: saved.activity.eventActivityId }, data: { importMetadata: json({ ...stored.importMetadata as FileMetadata, processingComplete: true }) } });
        }
        results.push({ ...summary, status: saved.status, eventId: saved.activity.eventId });
      } catch (error) { results.push({ ...summary, status: 'error', error: error instanceof Error ? error.message : 'Import failed' }); }
    }
    return { rows: results };
  }
}
