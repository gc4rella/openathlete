import client, { routes } from '@/utils/axios';
import { SPORT_TYPE } from '@openathlete/shared';

export type ImportRow = {
  sourceFile: string;
  fingerprint?: string;
  name?: string;
  format?: string;
  sport?: SPORT_TYPE;
  startDate?: string;
  distance?: number;
  movingTime?: number;
  warnings?: string[];
  status: 'ready' | 'merge' | 'imported' | 'merged' | 'duplicate' | 'error';
  error?: string;
  eventId?: number;
};

export async function previewActivityFile(file: File): Promise<ImportRow[]> {
  const body = new FormData();
  body.append('file', file);
  const response = await client.post<{ rows: ImportRow[] }>(routes.activityFiles.preview, body);
  return response.data.rows;
}

export async function importActivityFile(file: File, rows: ImportRow[]): Promise<ImportRow[]> {
  const body = new FormData();
  body.append('file', file);
  body.append('selection', JSON.stringify(rows.filter(row => row.fingerprint).map(row => ({ fingerprint: row.fingerprint, sport: row.sport ?? SPORT_TYPE.RUNNING }))));
  const response = await client.post<{ rows: ImportRow[] }>(routes.activityFiles.import, body);
  return response.data.rows;
}
