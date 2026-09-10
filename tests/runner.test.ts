import { describe, expect, it } from 'vitest';
import { applyLatencyAdjustment, runSuite, stat } from '../src/engine/runner';
import type { RunExecutor, RunSpec, SuiteConfig } from '../src/engine/runner';
import { MetricsAccumulator } from '../src/engine/metrics';
import { calibratePromptChars, textForTokens } from '../src/engine/prompts';
import type { RunMetrics, StreamConfig } from '../src/types';

const BASE: RunMetrics = {
  ...new MetricsAccumulator(() => 0).finalize(),
  ttfrMs: 100,
  ttftMs: 150,
  totalTimeMs: 1000,
  decodeTimeMs: 850,
  promptTokens: 128,
  completionTokens: 32,
  totalTokens: 160,
  tps: 50,
  tpotMs: 20,
  peakTps: 45,
  meanTps: 38,
  minTps: 30,
  peakWindowTps: 42,
  estPptMs: null,
  ppTps: null,
  finishReason: 'stop',
  content: 'ok',
  samples: [],
};

/**
 * Synthetic server: TTFR = 60ms + 0.2 ms/prompt-token; decode at a fixed tps.
 * prompt_tokens is derived from character length so prompt calibration works.
 */
function makeScriptedExecutor(tps = 50): { executor: RunExecutor; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const executor: RunExecutor = async (spec) => {
    calls.push(spec);
    const promptTokens = Math.max(
      1,
      Math.round(((spec.config.systemPrompt?.length ?? 0) + spec.config.prompt.length) / 4),
    );
    const completionTokens = spec.config.maxTokens ?? 32;
    const ttfr = 60 + promptTokens * 0.2;
    return {
      ...BASE,
      ttfrMs: ttfr,
      ttftMs: ttfr + 40,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      tps,
      tpotMs: 1000 / tps,
      decodeTimeMs: (completionTokens / tps) * 1000,
    };
  };
  return { executor, calls };
}

const baseConfig: StreamConfig = {
  endpoint: 'http://mock:15201',
  model: 'mock-7b',
  prompt: 'test',
  latencyMode: 'generation',
};

const smallSuite: SuiteConfig = {
  ppTargets: [128],
  tgCounts: [16],
  depths: [0],
  concurrencyLevels: [1],
  runs: 2,
  warmup: 1,
  exactTg: false,
  prefixCaching: false,
  coherence: true,
};

describe('runSuite', () => {
  it('runs pp and tg shapes, discards warmup, aggregates stats', async () => {
    const { executor, calls } = makeScriptedExecutor(50);
    const progress: Array<{ done: number; total: number; label: string }> = [];
    const result = await runSuite(
      baseConfig,
      smallSuite,
      { onProgress: (p) => progress.push(p) },
      undefined,
      executor,
    );

    // One pp row + one tg row.
    expect(result.rows.map((r) => r.kind)).toEqual(['pp', 'tg']);

    // Latency probes: 4 (one discarded) — and one calibration probe per target.
    const latencyProbes = calls.filter((c) => c.label === 'latency-probe');
    expect(latencyProbes).toHaveLength(4);
    // Both shapes calibrate target 128; the char cache dedupes to one probe.
    expect(calls.filter((c) => c.label === 'calibrate-prompt')).toHaveLength(1);

    // Measured runs only: warmup (1) discarded per row.
    for (const row of result.rows) {
      expect(row.runs).toHaveLength(smallSuite.runs);
      expect(row.stats.tps?.n).toBe(smallSuite.runs);
    }

    // tg row: synthetic server decodes at exactly 50 t/s, low variance.
    const tg = result.rows[1];
    expect(tg.stats.tps?.mean).toBeCloseTo(50, 0);
    expect(tg.stats.completionTokens?.mean).toBe(16);
    expect(tg.stats.tpotMs?.mean).toBeCloseTo(20, 0);

    // pp row: prefill of ~128 tokens at 0.2ms/token = ~25.6ms + 60ms base;
    // latency baseline ~= 60 + small-prompt*0.2 => est_ppt ~= prompt*0.2.
    const pp = result.rows[0];
    expect(pp.stats.ppTps?.mean).toBeGreaterThan(0);
    expect(pp.stats.estPptMs?.mean).toBeGreaterThan(0);

    // Coherence check ran against the synthetic executor ("ok" contains no 4).
    expect(result.coherenceOk).toBe(false);

    // Latency baseline recorded on the result.
    expect(result.latencyMs).not.toBeNull();
    expect(progress.length).toBeGreaterThan(0);
  }, 30000);

  it('measures aggregate throughput under concurrency', async () => {
    const { executor } = makeScriptedExecutor(50);
    const suite: SuiteConfig = {
      ...smallSuite,
      coherence: false,
      concurrencyLevels: [1, 4],
    };
    const result = await runSuite(baseConfig, suite, {}, undefined, executor);
    const tgRows = result.rows.filter((r) => r.kind === 'tg');
    expect(tgRows).toHaveLength(2);
    const c1 = tgRows.find((r) => r.concurrency === 1);
    const c4 = tgRows.find((r) => r.concurrency === 4);
    expect(c1?.totalTps).toBeNull(); // total t/s only tracked for concurrency > 1
    expect(c4?.totalTps?.mean).toBeGreaterThan(0);
    // Synthetic server has no contention: 4x requests ~= 4x aggregate tps.
    expect(c4!.totalTps!.mean).toBeGreaterThan(c1!.stats.tps!.mean * 2);
  }, 30000);

  it('emits prefix-caching context-load rows when enabled', async () => {
    const { executor } = makeScriptedExecutor(50);
    const suite: SuiteConfig = {
      ...smallSuite,
      coherence: false,
      depths: [256],
      prefixCaching: true,
    };
    const result = await runSuite(baseConfig, suite, {}, undefined, executor);
    const kinds = result.rows.map((r) => r.kind);
    expect(kinds).toContain('ctx_pp');
    expect(kinds).toContain('ctx_tg');
    // Context calibration probed the system-message route.
    expect(result.rows.every((r) => r.depth === 256)).toBe(true);
  }, 30000);

  it('reports exact progress totals and ends with Complete', async () => {
    const { executor } = makeScriptedExecutor(50);
    const events: Array<{ done: number; total: number; label: string }> = [];
    const suite: SuiteConfig = {
      ...smallSuite,
      coherence: false,
      concurrencyLevels: [1, 2],
    };
    const result = await runSuite(baseConfig, suite, { onProgress: (p) => events.push(p) }, undefined, executor);

    const last = events[events.length - 1];
    expect(last.label).toBe('Complete');
    expect(last.done).toBe(last.total);

    // Every intermediate event stays within bounds and counts in steps of 1 (pp) or 2 (tg c2).
    for (const e of events) {
      expect(e.done).toBeLessThanOrEqual(e.total);
      expect(e.done).toBeGreaterThan(0);
    }
    void result;
  }, 30000);

  it('busts the prompt cache on every measured row; only ctx-load rows repeat', async () => {
    const { executor, calls } = makeScriptedExecutor(50);
    await runSuite(baseConfig, { ...smallSuite, coherence: false }, {}, undefined, executor);

    // Plain rows always bust the cache: every measured prompt is unique.
    const tgPrompts = calls
      .filter((c) => c.label.startsWith('tg'))
      .map((c) => c.config.prompt);
    expect(tgPrompts.length).toBeGreaterThan(0);
    expect(new Set(tgPrompts).size).toBe(tgPrompts.length);
    const ppPrompts = calls
      .filter((c) => c.label.startsWith('pp'))
      .map((c) => c.config.prompt);
    expect(ppPrompts.length).toBeGreaterThan(0);
    expect(new Set(ppPrompts).size).toBe(ppPrompts.length);

    // With prefix-caching measurement on: plain rows still bust the cache;
    // only the ctx-load rows repeat the identical prompt so hits are measurable.
    const second = makeScriptedExecutor(50);
    await runSuite(
      baseConfig,
      { ...smallSuite, coherence: false, prefixCaching: true, depths: [256] },
      {},
      undefined,
      second.executor,
    );
    const tg2 = second.calls.filter((c) => c.label.startsWith('tg'));
    const prompts2 = tg2.map((c) => c.config.prompt);
    expect(prompts2.length).toBeGreaterThan(0);
    expect(new Set(prompts2).size).toBe(prompts2.length);
    const ctxPrompts = second.calls
      .filter((c) => c.label.startsWith('ctx_'))
      .map((c) => c.config.prompt);
    expect(ctxPrompts.length).toBeGreaterThan(0);
    expect(new Set(ctxPrompts).size).toBe(1);
  }, 30000);

  it('runs pp rows at every concurrency level with unique keys and labels', async () => {
    const { executor } = makeScriptedExecutor(50);
    const suite: SuiteConfig = { ...smallSuite, coherence: false, concurrencyLevels: [1, 2] };
    const result = await runSuite(baseConfig, suite, {}, undefined, executor);

    const ppRows = result.rows.filter((r) => r.kind === 'pp');
    expect(ppRows.map((r) => r.concurrency)).toEqual([1, 2]);
    expect(ppRows.map((r) => r.label)).toEqual(['pp128 (c1)', 'pp128 (c2)']);
    const keys = new Set(result.rows.map((r) => r.key));
    expect(keys.size).toBe(result.rows.length);

    // c2 pp row aggregates prompt-token throughput across both slots.
    const c2 = ppRows.find((r) => r.concurrency === 2)!;
    expect(c2.totalTps?.mean).toBeGreaterThan(0);
    // Measured runs: 2 iterations x 2 concurrent requests (warmup discarded).
    expect(c2.runs).toHaveLength(suite.runs * 2);
  }, 30000);

  it('excludes cached prefix tokens from pp rates when measuring prefix caching', async () => {
    const { executor } = makeScriptedExecutor(50);
    const suite: SuiteConfig = { ...smallSuite, coherence: false, prefixCaching: true, depths: [256] };
    const result = await runSuite(baseConfig, suite, {}, undefined, executor);

    const pp = result.rows.find((r) => r.kind === 'pp')!;
    const promptTokens = pp.stats.promptTokens?.mean ?? 0;
    expect(promptTokens).toBeGreaterThan(256); // ~256 ctx + ~128 prompt
    // pp tps x est_ppt must reconstruct only the newly processed tokens (~128).
    const newTokens = ((pp.stats.ppTps?.mean ?? 0) * (pp.stats.estPptMs?.mean ?? 0)) / 1000;
    expect(newTokens).toBeCloseTo(promptTokens - 256, 0);
    // ctx-load rows measure the full context (no subtraction).
    const ctxPp = result.rows.find((r) => r.kind === 'ctx_pp')!;
    const ctxTokens = ((ctxPp.stats.ppTps?.mean ?? 0) * (ctxPp.stats.estPptMs?.mean ?? 0)) / 1000;
    expect(ctxTokens).toBeCloseTo(ctxPp.stats.promptTokens?.mean ?? -1, 0);
  }, 30000);

  it('does not count context-load rows at depth 0 in the progress total', async () => {
    const { executor } = makeScriptedExecutor(50);
    const events: Array<{ done: number; total: number; label: string }> = [];
    const suite: SuiteConfig = { ...smallSuite, coherence: false, prefixCaching: true, concurrencyLevels: [1, 2] };
    const result = await runSuite(baseConfig, suite, { onProgress: (p) => events.push(p) }, undefined, executor);

    const last = events[events.length - 1];
    // 1 calibration + pp (3x1 + 3x2) + tg (3x1 + 3x2) = 19; no ctx rows at depth 0.
    expect(last.total).toBe(19);
    expect(last.done).toBe(19);
    expect(result.rows.every((r) => r.kind !== 'ctx_pp' && r.kind !== 'ctx_tg')).toBe(true);
  }, 30000);

  it('computes mean ± std correctly', () => {
    const s = stat([10, 10, 10, 10]);
    expect(s?.mean).toBe(10);
    expect(s?.std).toBe(0);
    const s2 = stat([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s2?.mean).toBeCloseTo(5, 5);
    expect(s2?.std).toBeCloseTo(2.138, 2);
  });

  it('applies latency adjustment: est_ppt = ttfr - baseline, pp = tokens/est', () => {
    const m = { ...BASE, ttfrMs: 300, promptTokens: 1000 };
    const adjusted = applyLatencyAdjustment(m, 100);
    expect(adjusted.estPptMs).toBe(200);
    expect(adjusted.ppTps).toBeCloseTo(1000 / 0.2, 5);
  });

  it('clamps est_ppt at zero when latency exceeds ttfr', () => {
    const adjusted = applyLatencyAdjustment({ ...BASE, ttfrMs: 50, promptTokens: 100 }, 100);
    expect(adjusted.estPptMs).toBe(0);
    expect(adjusted.ppTps).toBeNull();
  });

  it('leaves metrics untouched without a baseline', () => {
    const adjusted = applyLatencyAdjustment({ ...BASE, ttfrMs: 300, promptTokens: 1000 }, null);
    expect(adjusted.estPptMs).toBeNull();
    expect(adjusted.ppTps).toBeNull();
  });
});

describe('coherence check', () => {
  const { executor: answering } = makeScriptedExecutor(50);
  it('passes when the answer contains 4 or four', async () => {
    const { coherenceCheck } = await import('../src/engine/runner');
    const yes: RunExecutor = async () => ({ ...BASE, content: 'The answer is 4.' });
    const four: RunExecutor = async () => ({ ...BASE, content: 'two plus two equals four' });
    const no: RunExecutor = async () => ({ ...BASE, content: 'lorem ipsum dolor' });
    const thinking: RunExecutor = async () => ({
      ...BASE,
      content: '<think>2+2, simple. 2+2=4</think> 4',
    });
    const err: RunExecutor = async () => {
      throw new Error('boom');
    };
    expect(await coherenceCheck(baseConfig, undefined, yes)).toBe(true);
    expect(await coherenceCheck(baseConfig, undefined, four)).toBe(true);
    expect(await coherenceCheck(baseConfig, undefined, thinking)).toBe(true);
    expect(await coherenceCheck(baseConfig, undefined, no)).toBe(false);
    expect(await coherenceCheck(baseConfig, undefined, err)).toBeNull();
    void answering;
  });

  it('sends a deterministic, generously budgeted request', async () => {
    const { coherenceCheck } = await import('../src/engine/runner');
    let seen: RunSpec | null = null;
    const spy: RunExecutor = async (spec) => {
      seen = spec;
      return { ...BASE, content: '4' };
    };
    await coherenceCheck({ ...baseConfig, temperature: 0.9 }, undefined, spy);
    expect(seen!.config.temperature).toBe(0);
    expect(seen!.config.maxTokens).toBe(64);
    expect(seen!.config.prompt).toContain('2 + 2');
  });
});

describe('prompt calibration', () => {
  it('converges on the target token count via rescaling', async () => {
    // Server reports exactly chars/4 tokens.
    const probe = async (chars: number) => Math.round(chars / 4);
    const chars = await calibratePromptChars(probe, 512, 4);
    expect(Math.round(chars / 4)).toBeCloseTo(512, 0);
  });

  it('scales text length with the 4 chars/token heuristic', () => {
    expect(textForTokens(0)).toBe('');
    expect(textForTokens(10).length).toBe(40);
    expect(textForTokens(1000).length).toBeGreaterThanOrEqual(3900);
    expect(textForTokens(1000)).toContain('Sherlock');
  });
});