import { previewActivityFile, importActivityFile, type ImportRow } from '@/api/activity-file-import';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatDurationShort } from '@/components/training-plan-wizard/format';
import { Upload, FileCheck2, AlertTriangle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

export function ActivityFileImport() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);

  const choose = async (selected: File | undefined) => {
    if (!selected) return;
    setFile(selected); setRows([]); setBusy(true);
    try { setRows(await previewActivityFile(selected)); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not read this activity file.'); }
    finally { setBusy(false); }
  };
  const importRows = async () => {
    if (!file) return;
    setBusy(true);
    try { setRows(await importActivityFile(file, rows)); toast.success('Activity history imported.'); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Import failed.'); }
    finally { setBusy(false); }
  };
  return <Card className="overflow-hidden border-primary/20 bg-primary/[0.03]">
    <CardHeader className="pb-3"><div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><Upload className="h-5 w-5" /></div><div><CardTitle className="text-base">Bring in your history</CardTitle><CardDescription>FIT, TCX, GPX or a ZIP export. Files stay in your OpenAthlete account.</CardDescription></div></div></CardHeader>
    <CardContent className="space-y-3">
      <Input ref={input} type="file" accept=".fit,.tcx,.gpx,.zip,.gz" onChange={event => choose(event.target.files?.[0])} disabled={busy} />
      {rows.length > 0 && <div className="space-y-2">{rows.map((row, index) => <div key={`${row.sourceFile}-${index}`} className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"><div className="min-w-0"><div className="flex items-center gap-2 font-medium"><FileCheck2 className="h-4 w-4 text-primary" /><span className="truncate">{row.name ?? row.sourceFile}</span></div><div className="text-muted-foreground">{row.startDate ? new Date(row.startDate).toLocaleDateString() : '—'} · {row.distance ? `${(row.distance / 1000).toFixed(2)} km` : 'summary only'}{row.movingTime ? ` · ${formatDurationShort(row.movingTime)}` : ''}</div></div>{row.status === 'error' ? <span className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-4 w-4" />{row.error}</span> : <span className="text-xs uppercase text-muted-foreground">{row.status}</span>}</div>)}</div>}
      {rows.some(row => row.status === 'ready' || row.status === 'merge') && <Button onClick={importRows} disabled={busy}>{busy ? 'Reading…' : `Import ${rows.filter(row => row.status === 'ready' || row.status === 'merge').length} activities`}</Button>}
    </CardContent>
  </Card>;
}
