import { Decoder, Stream } from '@garmin/fitsdk';
import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { SportType } from '@openathlete/database';
import { type ActivityStream } from '@openathlete/shared';
import { calculateDistance } from './activity-parser.utils';

type Node = Record<string, unknown>;
const obj = (value: unknown): Node => value && typeof value === 'object' ? value as Node : {};
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const num = (value: unknown): number | undefined => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => obj(node)[key], value);
const MAX_FILE = 25 * 1024 * 1024;
const MAX_EXPANDED = 150 * 1024 * 1024;
const MAX_ENTRIES = 1000;

export type ActivitySample = {
  timestamp: number; lat?: number; lon?: number; distance?: number;
  altitude?: number; heartrate?: number; cadence?: number; watts?: number;
};
export type ImportedFileActivity = {
  fingerprint: string; name: string; sourceFile: string; format: string; sport: SportType;
  startDate: Date; endDate: Date; distance: number; movingTime: number;
  stream: ActivityStream; samples: ActivitySample[];
  laps: Array<{ startTimeSeconds: number; endTimeSeconds: number; orderIndex: number }>;
  warnings: string[];
};
export type ParsedImportRow = { sourceFile: string; activity?: ImportedFileActivity; error?: string };

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:?\d\d)$/.test(value)) throw new Error('A timestamp with a timezone is required');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid activity timestamp');
  return result;
}

function sport(value: unknown): SportType {
  const name = String(value ?? '').toLowerCase();
  if (['1', 'running', 'run', 'trail_running'].includes(name)) return SportType.RUNNING;
  if (['2', 'cycling', 'biking', 'bike'].includes(name)) return SportType.CYCLING;
  if (['5', 'swimming', 'swim'].includes(name)) return SportType.SWIMMING;
  if (['11', 'walking', 'walk'].includes(name)) return SportType.WALK;
  return SportType.OTHER;
}

/** Build only aligned streams. Sparse measurements remain in the original samples. */
export function normalizeSamples(samples: ActivitySample[], start: number): { stream: ActivityStream; distance: number; warnings: string[] } {
  const ordered = samples.filter(s => Number.isFinite(s.timestamp) && s.timestamp >= start).sort((a, b) => a.timestamp - b.timestamp)
    .filter((s, i, all) => i === 0 || s.timestamp !== all[i - 1].timestamp);
  const stream: ActivityStream = { time: ordered.map(s => (s.timestamp - start) / 1000) };
  const warnings: string[] = [];
  if (!ordered.length) return { stream: {}, distance: 0, warnings: ['SUMMARY_ONLY'] };
  let distance = 0;
  if (ordered.every(s => s.lat !== undefined && s.lon !== undefined && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180)) {
    stream.latlng = ordered.map(s => [s.lat!, s.lon!]);
    stream.distance = ordered.map((s, i) => {
      if (i > 0) distance += calculateDistance(ordered[i - 1].lat!, ordered[i - 1].lon!, s.lat!, s.lon!);
      return distance;
    });
  }
  for (const key of ['distance', 'altitude', 'heartrate', 'cadence', 'watts'] as const) {
    if (ordered.every(s => s[key] !== undefined && Number.isFinite(s[key]))) stream[key] = ordered.map(s => s[key]!);
    else if (ordered.some(s => s[key] !== undefined)) warnings.push(`SPARSE_${key.toUpperCase()}`);
  }
  return { stream, distance: stream.distance?.at(-1) ?? distance, warnings };
}

function finish(input: {
  name?: string; sourceFile: string; format: string; hash: string; index: number;
  sport: SportType; start: number; elapsed?: number; moving?: number; distance?: number;
  samples: ActivitySample[]; laps?: ImportedFileActivity['laps'];
}): ImportedFileActivity {
  if (input.samples.length > 200000) throw new Error('Activity has too many samples');
  const samples = input.samples.sort((a, b) => a.timestamp - b.timestamp);
  const normalized = normalizeSamples(samples, input.start);
  const elapsed = input.elapsed ?? ((samples.at(-1)?.timestamp ?? input.start) - input.start) / 1000;
  const moving = input.moving ?? elapsed;
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 7 * 86400 || moving <= 0 || moving > elapsed + 2) throw new Error('Invalid activity duration');
  const distance = input.distance ?? normalized.distance;
  if (!Number.isFinite(distance) || distance < 0) throw new Error('Invalid activity distance');
  const warnings = [...normalized.warnings];
  if (input.moving === undefined) warnings.push('MOVING_TIME_UNAVAILABLE');
  if (input.sport === SportType.OTHER) warnings.push('UNKNOWN_SPORT');
  if (!normalized.stream.heartrate) warnings.push('NO_HEART_RATE');
  return {
    fingerprint: `${input.hash}:${input.index}`, name: input.name || input.sourceFile.split('/').at(-1)!.replace(/\.[^.]+$/, ''),
    sourceFile: input.sourceFile, format: input.format, sport: input.sport,
    startDate: new Date(input.start), endDate: new Date(input.start + elapsed * 1000),
    distance, movingTime: Math.round(moving), stream: normalized.stream, samples,
    laps: input.laps ?? [], warnings,
  };
}

function parseFit(buffer: Buffer, sourceFile: string, hash: string): ImportedFileActivity[] {
  const decoder = new Decoder(Stream.fromBuffer(buffer));
  if (!decoder.isFIT() || !decoder.checkIntegrity()) throw new Error('Invalid or damaged FIT file');
  const decoded = decoder.read({ convertDateTimesToDates: true, convertTypesToStrings: true });
  const messages = decoded.messages;
  const errors = decoded.errors ?? [];
  if (!messages || errors.length) throw new Error('FIT decoding failed');
  const sessions = list(messages.sessionMesgs);
  if (!sessions.length) throw new Error('FIT file contains no completed activities');
  return sessions.map((value, index) => {
    const session = obj(value), start = timestamp(session.startTime);
    const elapsed = num(session.totalElapsedTime) ?? num(session.totalTimerTime);
    const end = start + (elapsed ?? 7 * 86400) * 1000;
    const samples = list(messages.recordMesgs).map(obj).filter(record => record.timestamp instanceof Date && record.timestamp.getTime() >= start && record.timestamp.getTime() <= end).map(record => ({
      timestamp: timestamp(record.timestamp),
      lat: num(record.positionLat) === undefined ? undefined : Number(record.positionLat) * 180 / 2 ** 31,
      lon: num(record.positionLong) === undefined ? undefined : Number(record.positionLong) * 180 / 2 ** 31,
      distance: num(record.distance), altitude: num(record.enhancedAltitude ?? record.altitude),
      heartrate: num(record.heartRate), cadence: num(record.cadence), watts: num(record.power),
    }));
    const laps = list(messages.lapMesgs).map(obj).filter(lap => lap.startTime instanceof Date && lap.startTime.getTime() >= start && lap.startTime.getTime() < end).map((lap, orderIndex) => {
      const startTimeSeconds = Math.max(0, Math.round((timestamp(lap.startTime) - start) / 1000));
      return { orderIndex, startTimeSeconds, endTimeSeconds: startTimeSeconds + Math.round(num(lap.totalElapsedTime) ?? num(lap.totalTimerTime) ?? 0) };
    }).filter(lap => lap.endTimeSeconds > lap.startTimeSeconds);
    return finish({ sourceFile, hash, index, format: 'FIT', sport: sport(session.sport), start, elapsed, moving: num(session.totalTimerTime), distance: num(session.totalDistance), samples, laps });
  });
}

function parseXml(buffer: Buffer, sourceFile: string, hash: string): ImportedFileActivity[] {
  const xml = buffer.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid XML activity file');
  const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml) as Node;
  const activities = list(at(root, 'TrainingCenterDatabase', 'Activities', 'Activity'));
  if (activities.length) return activities.map((value, index) => {
    const activity = obj(value), laps = list(activity.Lap).map(obj), start = timestamp(activity.Id ?? laps[0]?.['@_StartTime']);
    const samples = laps.flatMap(lap => list(lap.Track).flatMap(track => list(obj(track).Trackpoint))).map(obj).map(point => ({
      timestamp: timestamp(point.Time), lat: num(at(point, 'Position', 'LatitudeDegrees')), lon: num(at(point, 'Position', 'LongitudeDegrees')),
      distance: num(point.DistanceMeters), altitude: num(point.AltitudeMeters), heartrate: num(at(point, 'HeartRateBpm', 'Value')),
      cadence: num(point.Cadence ?? at(point, 'Extensions', 'TPX', 'RunCadence')), watts: num(at(point, 'Extensions', 'TPX', 'Watts')),
    }));
    const moving = laps.reduce((sum, lap) => sum + (num(lap.TotalTimeSeconds) ?? 0), 0);
    const elapsed = Math.max(moving, ((samples.at(-1)?.timestamp ?? start) - start) / 1000);
    return finish({ sourceFile, hash, index, format: 'TCX', name: typeof activity.Notes === 'string' ? activity.Notes.slice(0, 160) : undefined,
      sport: sport(activity['@_Sport']), start, elapsed, moving: moving || undefined,
      distance: laps.every(lap => num(lap.DistanceMeters) !== undefined) ? laps.reduce((sum, lap) => sum + Number(lap.DistanceMeters), 0) : undefined,
      samples, laps: laps.map((lap, orderIndex) => {
        const startTimeSeconds = Math.max(0, Math.round((timestamp(lap['@_StartTime']) - start) / 1000));
        return { orderIndex, startTimeSeconds, endTimeSeconds: startTimeSeconds + Math.round(num(lap.TotalTimeSeconds) ?? 0) };
      }).filter(lap => lap.endTimeSeconds > lap.startTimeSeconds),
    });
  });
  if (!root.gpx) throw new Error('Expected a GPX or TCX activity');
  const tracks = list(at(root, 'gpx', 'trk'));
  if (!tracks.length) throw new Error('GPX contains a route, not a recorded activity');
  return tracks.map((value, index) => {
    const track = obj(value);
    const samples = list(track.trkseg).flatMap(segment => list(obj(segment).trkpt)).map(obj).map(point => {
      const ext = obj(point.extensions), trackExt = obj(ext.TrackPointExtension);
      return { timestamp: timestamp(point.time), lat: num(point['@_lat']), lon: num(point['@_lon']), altitude: num(point.ele),
        heartrate: num(trackExt.hr ?? ext.hr), cadence: num(trackExt.cad ?? ext.cadence), watts: num(ext.power ?? trackExt.power) };
    });
    if (!samples.length) throw new Error('GPX contains no recorded points');
    return finish({ sourceFile, hash, index, format: 'GPX', name: typeof track.name === 'string' ? track.name : undefined,
      sport: sport(track.type), start: Math.min(...samples.map(s => s.timestamp)), samples });
  });
}

export function parseImportFile(buffer: Buffer, filename: string): ParsedImportRow[] {
  if (buffer.length > MAX_FILE) throw new Error('File exceeds 25 MB');
  let files = [{ name: filename, data: () => buffer, size: buffer.length }];
  if (/\.zip$/i.test(filename)) {
    const entries = new AdmZip(buffer).getEntries().filter(entry => !entry.isDirectory && /\.(fit|gpx|tcx)(\.gz)?$/i.test(entry.entryName) && !entry.entryName.startsWith('__MACOSX/'));
    if (entries.length > MAX_ENTRIES || entries.reduce((sum, entry) => sum + entry.header.size, 0) > MAX_EXPANDED) throw new Error('Archive exceeds 1000 activities or 150 MB expanded');
    files = entries.map(entry => ({ name: entry.entryName, data: () => entry.getData(), size: entry.header.size }));
  }
  if (!files.length) throw new Error('No FIT, TCX or GPX activities found');
  const rows: ParsedImportRow[] = [];
  for (const file of files) {
    try {
      if (file.size > MAX_FILE) throw new Error('Activity exceeds 25 MB');
      let data = file.data();
      if (/\.gz$/i.test(file.name)) data = gunzipSync(data, { maxOutputLength: MAX_FILE });
      if (data.length > MAX_FILE) throw new Error('Activity exceeds 25 MB');
      const hash = createHash('sha256').update(data).digest('hex');
      const activities = /\.fit(\.gz)?$/i.test(file.name) ? parseFit(data, file.name, hash) : parseXml(data, file.name, hash);
      rows.push(...activities.map(activity => ({ sourceFile: file.name, activity })));
    } catch (error) { rows.push({ sourceFile: file.name, error: error instanceof Error ? error.message : 'Cannot parse activity' }); }
  }
  return rows;
}
