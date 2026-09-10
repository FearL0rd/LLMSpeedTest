/**
 * Benchmark suite runner: executes test matrices (depth → pp → tg →
 * concurrency), applies latency adjustment, and aggregates mean ± std.
 * The executor is injectable so the whole orchestration is unit-testable.
 */
import { MetricsAccumulator } from './metrics';
import { calibratePromptChars, makeProbe, textForTokens } from './prompts';
import { streamCompletion } from './streaming';
import type { RunMetrics, StreamConfig } from '../types';

export type TestKind = 'pp' | 'tg' | 'ctx_pp' | 'ctx_tg';

export interface Stat {
  mean: number;
  std: number;
  min: number;
  max: number;
  n: number;
}

export interface SuiteRow {
  key: string;
  /** Human-readable test label in llama-benchy style, e.g. "pp2048 @ d4096 (c2)". */
  label: string;
  kind: TestKind;
  ppTarget: number;
  tgCount: number;
  depth: number;
  concurrency: number;
  /** Aggregate throughput across concurrent requests per iteration. */
  totalTps: Stat | null;
  runs: RunMetrics[];
  stats: Record<string, Stat>;
}

export interface SuiteConfig {
  /** Prompt-processing token targets for prefill tests. */
  ppTargets: number[];
  /** Generation token counts for decode tests. */
  tgCounts: number[];
  /** Context depths (padded natural text as system message). */
  depths: number[];
  /** Concurrent request levels. */
  concurrencyLevels: number[];
  runs: number;
  warmup: number;
  exactTg: boolean;
  prefixCaching: boolean;
  coherence: boolean;
}

export interface SuiteProgress {
  done: number;
  total: number;
  label: string;
}

export interface SuiteResult {
  id: string;
  label: string;
  model: string;
  endpoint: string;
  createdAt: number;
  latencyMs: number | null;
  latencyMode: string;
  coherenceOk: boolean | null;
  rows: SuiteRow[];
  config: SuiteConfig;
}

/** Full request spec handed to the executor. */
export interface RunSpec {
  label: string;
  config: StreamConfig;
}

export type RunExecutor = (spec: RunSpec, signal?: AbortSignal) => Promise<RunMetrics>;

/** Production executor: streams one completion and returns its metrics. */
export const defaultExecutor: RunExecutor = async (spec, signal) => {
  const acc = new MetricsAccumulator();
  acc.start();
  await streamCompletion(spec.config, (c) => acc.ingest(c), signal);
  return acc.finalize();
};

export function stat(values: number[]): Stat | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, std: Math.sqrt(variance), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

const METRIC_KEYS = [
  'tps',
  'peakWindowTps',
  'ttfrMs',
  'ttftMs',
  'estPptMs',
  'ppTps',
  'tpotMs',
  'promptTokens',
  'completionTokens',
] as const;

function aggregate(runs: RunMetrics[]): Record<string, Stat> {
  const out: Record<string, Stat> = {};
  for (const key of METRIC_KEYS) {
    const s = stat(runs.map((r) => r[key] as number | null).filter((v): v is number => v !== null));
    if (s) out[key] = s;
  }
  return out;
}

/** Apply latency adjustment to a finished run (est_ppt, prompt-processing tps).
 *  `cachedPrefixTokens` subtracts context served from the server's prefix
 *  cache so pp rates reflect only the newly processed tokens. */
export function applyLatencyAdjustment(
  m: RunMetrics,
  latencyMs: number | null,
  cachedPrefixTokens = 0,
): RunMetrics {
  if (m.ttfrMs === null || latencyMs === null) return m;
  const estPptMs = Math.max(0, m.ttfrMs - latencyMs);
  const ppTps =
    estPptMs > 0 && m.promptTokens !== null && m.promptTokens > 0
      ? Math.max(1, m.promptTokens - cachedPrefixTokens) / (estPptMs / 1000)
      : null;
  return { ...m, estPptMs, ppTps };
}

/** Ask the model a deterministic question; useful sanity gate after warmup. */
export async function coherenceCheck(
  config: StreamConfig,
  signal?: AbortSignal,
  executor: RunExecutor = defaultExecutor,
): Promise<boolean | null> {
  try {
    const m = await executor(
      {
        label: 'coherence',
        config: {
          ...config,
          systemPrompt: '',
          prompt: 'What is 2 + 2? Reply with just the number.',
          // Deterministic decoding, and a generous budget so reasoning-style
          // models can finish their thinking before answering.
          temperature: 0,
          maxTokens: 64,
          minTokens: undefined,
          ignoreEos: undefined,
        },
      },
      signal,
    );
    // "4", "= 4", "four", possibly embedded in reasoning text.
    return /\b4\b|\bfour\b/i.test(m.content);
  } catch {
    return null;
  }
}

/** Baseline latency from 1-token generation probes (first one discarded). */
export async function measureLatencyWith(
  config: StreamConfig,
  executor: RunExecutor,
  signal?: AbortSignal,
): Promise<number | null> {
  const probe: StreamConfig = {
    ...config,
    systemPrompt: '',
    prompt: 'Hi',
    maxTokens: 1,
    minTokens: undefined,
    ignoreEos: undefined,
  };
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    try {
      const m = await executor({ label: 'latency-probe', config: probe }, signal);
      // First probe warms up the request shape and is discarded.
      if (i > 0 && m.ttfrMs !== null) samples.push(m.ttfrMs);
    } catch {
      break;
    }
  }
  if (samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function tgShapeConfig(config: StreamConfig, suite: SuiteConfig, tg: number): StreamConfig {
  return {
    ...config,
    maxTokens: tg,
    minTokens: suite.exactTg ? tg : undefined,
    ignoreEos: suite.exactTg ? true : undefined,
  };
}

/** Deterministic context text; optional nonce avoids prefix-cache hits. */
function buildContextText(chars: number, addNonce: boolean): string {
  const base = textForTokens(Math.ceil(chars / 4));
  return addNonce ? `${base}\n[nonce ${Math.random().toString(36).slice(2, 10)}]` : base;
}

/**
 * Run the full suite. Matrix order: depth → pp (prefill) → tg (decode),
 * with concurrency multiplying the iterations of each shape.
 */
export async function runSuite(
  config: StreamConfig,
  suite: SuiteConfig,
  handlers: {
    onProgress?: (p: SuiteProgress) => void;
    onRow?: (row: SuiteRow) => void;
  } = {},
  signal?: AbortSignal,
  executor: RunExecutor = defaultExecutor,
): Promise<SuiteResult> {
  const progress = { done: 0 };
  // Progress denominator matches the actual tick accounting exactly:
  // every row runs one request per concurrent slot per iteration.
  const iterations = suite.warmup + suite.runs;
  let estimatedTotal = 0;
  for (const depth of suite.depths) {
    estimatedTotal += 1; // depth calibration tick
    if (suite.prefixCaching && depth > 0) {
      estimatedTotal += 2 * suite.concurrencyLevels.length * iterations; // ctx load rows
    }
    for (const c of suite.concurrencyLevels) {
      estimatedTotal += suite.ppTargets.length * iterations * c;
      estimatedTotal += suite.tgCounts.length * iterations * c;
    }
  }
  const report = (label: string) => handlers.onProgress?.({ done: progress.done, total: estimatedTotal, label });

  // Latency baseline via the same executor keeps tests hermetic.
  const latencyMs =
    (config.latencyMode ?? 'generation') === 'none'
      ? null
      : await measureLatencyWith(config, executor, signal);

  let coherenceOk: boolean | null = null;
  if (suite.coherence) {
    report('Coherence check');
    coherenceOk = await coherenceCheck(config, signal, executor);
  }

  const rows: SuiteRow[] = [];
  const ctxCharsCache = new Map<number, number>();
  const promptCharsCache = new Map<number, number>();
  const ctxProbe = makeProbe((text) => ({ ...config, systemPrompt: text, prompt: '.' }), (c) =>
    executor({ label: 'calibrate-ctx', config: c }, signal),
  );
  const promptProbe = makeProbe((text) => ({ ...config, systemPrompt: '', prompt: text }), (c) =>
    executor({ label: 'calibrate-prompt', config: c }, signal),
  );

  const calibrateCtx = async (depth: number): Promise<number> => {
    const cached = ctxCharsCache.get(depth);
    if (cached !== undefined) return cached;
    let chars = depth > 0 ? depth * 4 : 0;
    if (depth > 0) {
      try {
        chars = await calibratePromptChars(ctxProbe, depth);
      } catch {
        // Server rejected the probe (e.g. depth exceeds its context): fall
        // back to the 4 chars/token heuristic so the suite still completes.
      }
    }
    ctxCharsCache.set(depth, chars);
    return chars;
  };
  const calibratePrompt = async (target: number): Promise<number> => {
    const cached = promptCharsCache.get(target);
    if (cached !== undefined) return cached;
    let chars = target > 0 ? target * 4 : 0;
    if (target > 0) {
      try {
        chars = await calibratePromptChars(promptProbe, target);
      } catch {
        // Heuristic fallback keeps the rest of the suite running.
      }
    }
    promptCharsCache.set(target, chars);
    return chars;
  };

  for (const depth of suite.depths) {
    if (signal?.aborted) break;
    progress.done++;
    report(`Calibrating context @ depth ${depth}`);
    const ctxChars = await calibrateCtx(depth);
    const systemText = depth > 0 ? buildContextText(ctxChars, !suite.prefixCaching) : '';
    // With prefix caching on, the shared system context is served from the
    // server's cache; pp rates must count only the newly processed tokens.
    const cachedPrefixTokens = suite.prefixCaching && depth > 0 ? Math.round(systemText.length / 4) : 0;

    // Matrix order mirrors llama-benchy: per (depth, concurrency) run
    // ctx-load rows (depth > 0), then pp, then tg.
    for (const concurrency of suite.concurrencyLevels) {
      // Prefix-caching measurement: load the context first (ctx_* rows), then
      // subsequent rows at this depth run against the cached context.
      if (suite.prefixCaching && depth > 0) {
        for (const [kind, tg] of [
          ['ctx_pp', 1],
          ['ctx_tg', suite.tgCounts[0] ?? 8],
        ] as const) {
          const row = blankRow(kind, 0, tg, depth, concurrency);
          await runRow(config, row, {
            systemText,
            promptText: '.',
            maxTokens: tg,
            iterations: suite.warmup + suite.runs,
            warmup: suite.warmup,
            concurrency,
            cacheBust: false, // ctx-load rows must hit the cache
            tpsTokens: 'prompt',
            cachedPrefixTokens: 0, // ctx rows measure loading the full context
            onIteration: () => {
              progress.done += concurrency;
              report(`${row.label} — cache load`);
            },
          }, signal, executor, latencyMs);
          rows.push(row);
          handlers.onRow?.(row);
        }
      }

      for (const ppTarget of suite.ppTargets) {
        const promptChars = await calibratePrompt(ppTarget);
        const row = blankRow('pp', ppTarget, 1, depth, concurrency);
        await runRow(config, row, {
          systemText,
          promptText: textForTokens(Math.ceil(promptChars / 4)),
          maxTokens: 1,
          iterations: suite.warmup + suite.runs,
          warmup: suite.warmup,
          concurrency,
          // Repeated identical prompts let the server's prefix cache fake
          // near-zero prefill times — bust it on every measured request.
          cacheBust: true,
          tpsTokens: 'prompt',
          cachedPrefixTokens,
          onIteration: () => {
            progress.done += concurrency;
            report(row.label);
          },
        }, signal, executor, latencyMs);
        rows.push(row);
        handlers.onRow?.(row);
      }

      for (const tgCount of suite.tgCounts) {
        const promptChars = await calibratePrompt(suite.ppTargets[0] ?? 64);
        const row = blankRow('tg', suite.ppTargets[0] ?? 64, tgCount, depth, concurrency);
        await runRow(tgShapeConfig(config, suite, tgCount), row, {
          systemText,
          promptText: textForTokens(Math.ceil(promptChars / 4)),
          maxTokens: tgCount,
          iterations: suite.warmup + suite.runs,
          warmup: suite.warmup,
          concurrency,
          cacheBust: true,
          tpsTokens: 'completion',
          cachedPrefixTokens,
          onIteration: () => {
            progress.done += concurrency;
            report(row.label);
          },
        }, signal, executor, latencyMs);
        rows.push(row);
        handlers.onRow?.(row);
      }
    }
  }

  handlers.onProgress?.({
    done: signal?.aborted ? progress.done : estimatedTotal,
    total: estimatedTotal,
    label: signal?.aborted ? 'Cancelled' : 'Complete',
  });

  return {
    id: `suite-${Date.now()}`,
    label: config.label?.trim() || config.model,
    model: config.model,
    endpoint: config.endpoint,
    createdAt: Date.now(),
    latencyMs,
    latencyMode: config.latencyMode ?? 'generation',
    coherenceOk,
    rows,
    config: { ...suite },
  };
}

// ---------------------------------------------------------------------------

interface RowOptions {
  systemText: string;
  promptText: string;
  maxTokens: number;
  iterations: number;
  warmup: number;
  concurrency: number;
  /**
   * Append a unique nonce per request so server-side prefix caching cannot
   * serve repeated prompts (which would fake near-zero prefill times).
   */
  cacheBust: boolean;
  /** Which token count drives aggregate t/s: prompt tokens for pp rows, completion tokens for tg rows. */
  tpsTokens: 'prompt' | 'completion';
  /** Tokens already served from the server's prefix cache; excluded from pp rates. */
  cachedPrefixTokens: number;
  onIteration?: () => void;
}

function blankRow(kind: TestKind, pp: number, tg: number, depth: number, concurrency: number): SuiteRow {
  const shape = kind === 'pp' ? `pp${pp}` : kind === 'tg' ? `tg${tg}` : kind;
  return {
    key: `${shape}@d${depth}:c${concurrency}`,
    label: `${shape}${depth > 0 ? ` @ d${depth}` : ''} (c${concurrency})`,
    kind,
    ppTarget: pp,
    tgCount: tg,
    depth,
    concurrency,
    totalTps: null,
    runs: [],
    stats: {},
  };
}

async function runRow(
  config: StreamConfig,
  row: SuiteRow,
  opts: RowOptions,
  signal?: AbortSignal,
  executor: RunExecutor = defaultExecutor,
  latencyMs: number | null = null,
): Promise<void> {
  const totalTpsSamples: number[] = [];
  for (let i = 0; i < opts.iterations; i++) {
    if (signal?.aborted) break;
    const t0 = performance.now();
    const specs: RunSpec[] = Array.from({ length: opts.concurrency }, (_, k) => ({
      label: `${row.key} #${i}.${k}`,
      config: {
        ...config,
        systemPrompt: opts.systemText || undefined,
        prompt: opts.cacheBust
          ? `${opts.promptText} [${i}.${k}.${Math.random().toString(36).slice(2, 10)}]`
          : opts.promptText || '.',
        maxTokens: opts.maxTokens,
      },
    }));
    const results = await Promise.all(
      specs.map(async (spec) => {
        try {
          return await executor(spec, signal);
        } catch {
          return null;
        }
      }),
    );
    const ok = results.filter((r): r is RunMetrics => r !== null);
    const span = performance.now() - t0;
    if (opts.concurrency > 1 && ok.length > 0 && span > 0) {
      const tokens = ok.reduce(
        (a, m) => a + (opts.tpsTokens === 'prompt' ? m.promptTokens ?? 0 : m.completionTokens ?? 0),
        0,
      );
      if (tokens > 0) totalTpsSamples.push((tokens / span) * 1000);
    }
    // Discard the first `warmup` iterations.
    if (i >= opts.warmup) {
      for (const m of ok) row.runs.push(applyLatencyAdjustment(m, latencyMs, opts.cachedPrefixTokens));
    }
    opts.onIteration?.();
  }
  row.stats = aggregate(row.runs);
  row.totalTps = stat(totalTpsSamples);
}