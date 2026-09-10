/**
 * Export helpers: Markdown / CSV / JSON serialization for suite results and
 * saved runs, plus browser download / file-import plumbing.
 */
import type { SavedRun } from '../types';
import type { Stat, SuiteResult, SuiteRow } from './runner';
import { isTauri } from './streaming';

export function fmtStat(s: Stat | undefined, digits = 2): string {
  if (!s) return '';
  return `${s.mean.toFixed(digits)} ± ${s.std.toFixed(digits)}`;
}

export function rowTestLabel(row: SuiteRow): string {
  return row.label;
}

/** Per-request throughput: prompt-processing speed for pp rows, decode speed for tg rows. */
export function rowReqTps(row: SuiteRow): Stat | undefined {
  return (row.kind === 'pp' || row.kind === 'ctx_pp' ? row.stats.ppTps : row.stats.tps) ?? undefined;
}

/** Aggregate throughput across concurrent requests; falls back to the per-request rate at c1. */
export function rowTotalTps(row: SuiteRow): Stat | undefined {
  if (row.totalTps) return row.totalTps;
  return row.concurrency === 1 ? rowReqTps(row) : undefined;
}

/** Peak 1-second-window decode speed (per request; blank for pp rows). */
export function rowPeakTps(row: SuiteRow): Stat | undefined {
  return row.kind === 'tg' || row.kind === 'ctx_tg' ? row.stats.peakWindowTps ?? undefined : undefined;
}

/** Combined peak is only measurable where requests do not overlap (c1). */
export function rowPeakTpsTotal(row: SuiteRow): Stat | undefined {
  return row.concurrency === 1 ? rowPeakTps(row) : undefined;
}

export function suiteToMarkdown(result: SuiteResult): string {
  const head =
    '| test | t/s (total) | t/s (req) | peak t/s | peak t/s (req) | ttfr (ms) | est_ppt (ms) | e2e_ttft (ms) | tpot (ms) |\n' +
    '|:------------------------|---------------:|--------------:|-----------:|-----------------:|-----------:|-------------:|----------------:|-----------:|';
  const lines = result.rows.map((row) => {
    const cells = [
      rowTestLabel(row),
      fmtStat(rowTotalTps(row)),
      fmtStat(rowReqTps(row)),
      fmtStat(rowPeakTpsTotal(row)),
      fmtStat(rowPeakTps(row)),
      fmtStat(row.stats.ttfrMs),
      fmtStat(row.stats.estPptMs),
      fmtStat(row.stats.ttftMs),
      fmtStat(row.stats.tpotMs),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [
    `# Benchmark — ${result.label} (${result.model})`,
    '',
    `endpoint: ${result.endpoint}  |  latency mode: ${result.latencyMode}` +
      (result.latencyMs !== null ? ` (${result.latencyMs.toFixed(1)} ms baseline)` : '') +
      (result.coherenceOk !== null ? `  |  coherence: ${result.coherenceOk ? 'OK' : 'FAILED'}` : ''),
    '',
    head,
    ...lines,
    '',
  ].join('\n');
}

export function suiteToCsv(result: SuiteResult): string {
  const header = [
    'test',
    'kind',
    'depth',
    'pp_target',
    'tg_count',
    'concurrency',
    'n',
    'tps_mean',
    'tps_std',
    'peak_tps_mean',
    'ttfr_ms_mean',
    'ttft_ms_mean',
    'est_ppt_ms_mean',
    'tpot_ms_mean',
    'total_tps_mean',
    'total_tps_std',
  ].join(',');
  const req = (row: SuiteRow) => rowReqTps(row);
  const lines = result.rows.map((row) =>
    [
      rowTestLabel(row),
      row.kind,
      row.depth,
      row.ppTarget,
      row.tgCount,
      row.concurrency,
      req(row)?.n ?? 0,
      req(row)?.mean.toFixed(3) ?? '',
      req(row)?.std.toFixed(3) ?? '',
      rowPeakTps(row)?.mean.toFixed(3) ?? '',
      row.stats.ttfrMs?.mean.toFixed(2) ?? '',
      row.stats.ttftMs?.mean.toFixed(2) ?? '',
      row.stats.estPptMs?.mean.toFixed(2) ?? '',
      row.stats.tpotMs?.mean.toFixed(3) ?? '',
      row.totalTps?.mean.toFixed(3) ?? '',
      row.totalTps?.std.toFixed(3) ?? '',
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

export function runsToCsv(runs: SavedRun[]): string {
  const header = [
    'label',
    'model',
    'hardware',
    'endpoint',
    'created_at',
    'ttft_ms',
    'ttfr_ms',
    'tps',
    'tpot_ms',
    'peak_tps',
    'pp_tps',
    'prompt_tokens',
    'completion_tokens',
  ].join(',');
  const lines = runs.map((r) =>
    [
      `"${r.label.replace(/"/g, '""')}"`,
      r.model,
      `"${(r.hardware ?? '').replace(/"/g, '""')}"`,
      r.endpoint,
      new Date(r.createdAt).toISOString(),
      r.metrics.ttftMs?.toFixed(1) ?? '',
      r.metrics.ttfrMs?.toFixed(1) ?? '',
      r.metrics.tps?.toFixed(2) ?? '',
      r.metrics.tpotMs?.toFixed(3) ?? '',
      r.metrics.peakWindowTps?.toFixed(2) ?? r.metrics.peakTps?.toFixed(2) ?? '',
      r.metrics.ppTps?.toFixed(2) ?? '',
      r.metrics.promptTokens ?? '',
      r.metrics.completionTokens ?? '',
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

/**
 * Save text content to a file.
 *
 * Inside the desktop app this opens a native Save As dialog and writes the
 * file through the fs plugin — the webview's blob-URL downloads are
 * unreliable (racy revoke on WebView2, silently dropped on WebKitGTK).
 * In plain-browser dev mode it falls back to the anchor-download trick.
 */
export async function download(filename: string, content: string, mime: string): Promise<void> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : 'txt';
    const path = await save({
      defaultPath: filename,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return; // user cancelled the dialog
    await writeTextFile(path, content);
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late: revoking synchronously after click() can cancel the
  // download before the blob has been read.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Parse an imported runs/suite JSON file, tolerating single-item payloads. */
export function parseImportedRuns(json: string): SavedRun[] {
  const value: unknown = JSON.parse(json);
  const arr = Array.isArray(value) ? value : [value];
  const runs: SavedRun[] = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object') {
      const r = item as Partial<SavedRun>;
      if (typeof r.id === 'string' && r.metrics && typeof r.model === 'string') {
        runs.push({ hardware: undefined, ...r } as SavedRun);
      }
    }
  }
  if (runs.length === 0) throw new Error('No valid saved runs found in file');
  return runs;
}