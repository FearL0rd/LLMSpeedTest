/**
 * Export helpers: Markdown / CSV / JSON serialization for suite results and
 * saved runs, plus browser download / file-import plumbing.
 */
import type { SavedRun } from '../types';
import type { Stat, SuiteResult, SuiteRow } from './runner';

export function fmtStat(s: Stat | undefined, digits = 2): string {
  if (!s) return '';
  return `${s.mean.toFixed(digits)} ± ${s.std.toFixed(digits)}`;
}

function rowTestLabel(row: SuiteRow): string {
  if (row.kind === 'pp') return `pp${row.ppTarget} @ d${row.depth}`;
  if (row.kind === 'tg') return `tg${row.tgCount} @ d${row.depth}${row.concurrency > 1 ? ` (c${row.concurrency})` : ''}`;
  if (row.kind === 'ctx_pp') return `ctx_pp @ d${row.depth}`;
  return `ctx_tg @ d${row.depth}`;
}

export function suiteToMarkdown(result: SuiteResult): string {
  const head =
    '| test | t/s | peak t/s | pp t/s | ttfr (ms) | e2e ttft (ms) | est_ppt (ms) |\n' +
    '|:-----|----:|---------:|-------:|----------:|--------------:|-------------:|';
  const lines = result.rows.map((row) => {
    const cells = [
      rowTestLabel(row),
      fmtStat(row.stats.tps),
      fmtStat(row.stats.peakWindowTps),
      fmtStat(row.stats.ppTps),
      fmtStat(row.stats.ttfrMs),
      fmtStat(row.stats.ttftMs),
      fmtStat(row.stats.estPptMs),
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
    'pp_tps_mean',
    'ttfr_ms_mean',
    'ttft_ms_mean',
    'est_ppt_ms_mean',
    'total_tps_mean',
  ].join(',');
  const lines = result.rows.map((row) =>
    [
      rowTestLabel(row),
      row.kind,
      row.depth,
      row.ppTarget,
      row.tgCount,
      row.concurrency,
      row.stats.tps?.n ?? 0,
      row.stats.tps?.mean.toFixed(3) ?? '',
      row.stats.tps?.std.toFixed(3) ?? '',
      row.stats.peakWindowTps?.mean.toFixed(3) ?? '',
      row.stats.ppTps?.mean.toFixed(3) ?? '',
      row.stats.ttfrMs?.mean.toFixed(2) ?? '',
      row.stats.ttftMs?.mean.toFixed(2) ?? '',
      row.stats.estPptMs?.mean.toFixed(2) ?? '',
      row.totalTps?.mean.toFixed(3) ?? '',
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

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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