import { describe, expect, it } from 'vitest';
import { fmtStat, parseImportedRuns, runsToCsv, suiteToCsv, suiteToMarkdown } from '../src/engine/export';
import type { SuiteRow } from '../src/engine/runner';
import type { SavedRun } from '../src/types';

const BASE_METRICS = {
  ttfrMs: 186.83,
  ttftMs: 150,
  totalTimeMs: 5000,
  decodeTimeMs: 4800,
  promptTokens: 512,
  completionTokens: 64,
  totalTokens: 576,
  tps: 13.33,
  tpotMs: 75,
  peakTps: 20,
  meanTps: 14,
  minTps: 8,
  peakWindowTps: 19.5,
  estPptMs: 87.96,
  ppTps: 5821,
  engineTps: null,
  engineTpotMs: null,
  engineTtftMs: null,
  engineEvalCount: null,
  enginePromptEvalCount: null,
  finishReason: 'stop',
  content: 'ok',
  samples: [],
  diagnostics: { chunks: 70, contentChunks: 64, usageChunks: 1 },
} as const;

function makeRow(overrides: Partial<SuiteRow> = {}): SuiteRow {
  return {
    key: 'tg64@d0',
    kind: 'tg',
    ppTarget: 512,
    tgCount: 64,
    depth: 0,
    concurrency: 1,
    totalTps: null,
    runs: [],
    stats: {
      tps: { mean: 13.33, std: 0.45, min: 12.8, max: 14.1, n: 2 },
      ttfrMs: { mean: 186.83, std: 9.46, min: 177, max: 196, n: 2 },
    },
    ...overrides,
  };
}

const suiteResult = {
  id: 'suite-123',
  label: 'Mock run',
  model: 'mock-7b',
  endpoint: 'http://localhost:15201',
  createdAt: 1757000000000,
  latencyMs: 98.9,
  latencyMode: 'generation',
  coherenceOk: true,
  rows: [makeRow(), makeRow({ key: 'pp512@d0', kind: 'pp' as const, tgCount: 1 })],
  config: {
    ppTargets: [512],
    tgCounts: [64],
    depths: [0],
    concurrencyLevels: [1],
    runs: 2,
    warmup: 1,
    exactTg: false,
    prefixCaching: false,
    coherence: true,
  },
};

describe('suiteToMarkdown', () => {
  it('renders a header with metadata and one line per row', () => {
    const md = suiteToMarkdown(suiteResult as never);
    expect(md).toContain('# Benchmark — Mock run (mock-7b)');
    expect(md).toContain('latency mode: generation (98.9 ms baseline)');
    expect(md).toContain('coherence: OK');
    expect(md).toContain('| tg64 @ d0 |');
    expect(md).toContain('| pp512 @ d0 |');
    expect(md).toContain('13.33 ± 0.45');
  });

  it('shows the pp speed for pp rows in the t/s column', () => {
    const md = suiteToMarkdown(suiteResult as never);
    const ppLine = md.split('\n').find((l) => l.startsWith('| pp512'));
    expect(ppLine).toContain('|  |'); // decode t/s blank for pp rows
  });
});

describe('suiteToCsv', () => {
  it('emits a header and one CSV line per row', () => {
    const csv = suiteToCsv(suiteResult as never);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('test,kind,depth,pp_target,tg_count,concurrency,n,tps_mean,tps_std');
    expect(lines[1]).toContain('tg64 @ d0,tg,0,512,64,1,2,13.330,0.450');
    expect(lines[2]).toContain('pp512 @ d0,pp,0,512,1,1,2');
  });
});

describe('runsToCsv', () => {
  it('escapes quotes in labels and includes key metrics', () => {
    const run: SavedRun = {
      id: 'run-1',
      label: 'My "quoted" label',
      model: 'mock-7b',
      endpoint: 'http://localhost:15201',
      hardware: 'RTX 4090 · 24 GB',
      createdAt: 1757000000000,
      config: { endpoint: 'http://localhost:15201', model: 'mock-7b', prompt: 'p' },
      metrics: { ...BASE_METRICS },
    };
    const csv = runsToCsv([run]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('label,model,hardware,endpoint,created_at,ttft_ms,ttfr_ms,tps');
    expect(lines[1]).toContain('"My ""quoted"" label"');
    expect(lines[1]).toContain('RTX 4090 · 24 GB');
    expect(lines[1]).toContain('13.33');
    expect(lines[1]).toContain('5821');
  });
});

describe('fmtStat', () => {
  it('formats mean ± std and empty for missing stats', () => {
    expect(fmtStat({ mean: 1.25, std: 0.5, min: 1, max: 2, n: 2 })).toBe('1.25 ± 0.50');
    expect(fmtStat(undefined)).toBe('');
  });
});

describe('parseImportedRuns', () => {
  it('accepts arrays and single objects of saved runs', () => {
    const run = {
      id: 'run-1',
      label: 'a',
      model: 'm',
      endpoint: 'http://x',
      createdAt: 1,
      config: {},
      metrics: { ...BASE_METRICS },
    };
    expect(parseImportedRuns(JSON.stringify([run]))).toHaveLength(1);
    expect(parseImportedRuns(JSON.stringify(run))).toHaveLength(1);
  });

  it('rejects files without valid runs', () => {
    expect(() => parseImportedRuns('{"nope": true}')).toThrow(/No valid saved runs/);
    expect(() => parseImportedRuns('not json')).toThrow();
  });
});