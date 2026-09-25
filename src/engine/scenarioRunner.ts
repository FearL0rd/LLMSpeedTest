/**
 * Runs the four llm-bench-style scenarios against an endpoint: one streamed
 * generation per scenario (fixed prompt + temperature), followed by optional
 * LLM-judge scoring. Memory / GPU-split metrics come from Ollama /api/ps
 * (blank on engines that do not expose them).
 */
import { MetricsAccumulator } from './metrics';
import { applyLatencyAdjustment } from './runner';
import { measureBaselineLatency, warmUpCards } from './latency';
import { streamCompletion } from './streaming';
import { findModelMemory, getGpuStats, isSameHost, pickGpu, probeEndpoint } from './probe';
import { SCENARIOS, efficiencyRatio, stripThink, weightedKpi, type ScenarioDef } from './scenarios';
import { buildJudgePrompt, parseJudgeScores } from './judge';
import type { RunMetrics, SpeedSample, StreamConfig } from '../types';

export interface ScenarioResult {
  scenarioId: ScenarioDef['id'];
  name: string;
  focus: string;
  temperature: number;
  status: 'pending' | 'running' | 'judging' | 'done' | 'failed';
  error: string | null;
  metrics: RunMetrics | null;
  /** Final answer, chain-of-thought stripped (what gets judged). */
  response: string;
  // llm-bench metrics
  tps: number | null;
  ttftMs: number | null;
  ppTps: number | null;
  memoryBytes: number | null;
  vramBytes: number | null;
  gpuPercent: number | null;
  efficiency: number | null;
  // Optional LLM-judge quality scores
  scores: Record<string, number> | null;
  kpi: number | null;
  judgeModel: string | null;
  judgeError: string | null;
}

export interface ScenarioSuiteResult {
  id: string;
  model: string;
  endpoint: string;
  judged: boolean;
  judgeModel: string | null;
  judgeEndpoint: string | null;
  startedAt: number;
  /** Mean KPI across scored scenarios. */
  overallKpi: number | null;
  results: ScenarioResult[];
}

export interface ScenarioSuiteHandlers {
  onProgress?: (label: string) => void;
  onScenarios?: (results: ScenarioResult[]) => void;
  /** Live answer text of the currently running scenario. */
  onLiveAnswer?: (text: string) => void;
  onSample?: (sample: SpeedSample) => void;
}

function blankResult(def: ScenarioDef): ScenarioResult {
  return {
    scenarioId: def.id,
    name: def.name,
    focus: def.focus,
    temperature: def.temperature,
    status: 'pending',
    error: null,
    metrics: null,
    response: '',
    tps: null,
    ttftMs: null,
    ppTps: null,
    memoryBytes: null,
    vramBytes: null,
    gpuPercent: null,
    efficiency: null,
    scores: null,
    kpi: null,
    judgeModel: null,
    judgeError: null,
  };
}

/**
 * Run the four scenarios in sequence, then judge their answers when enabled.
 * Judged by `judgeModel` (falls back to the model under test — self-grading
 * bias applies; use a stronger model when you can).
 */
export async function runScenarioSuite(
  config: StreamConfig,
  opts: { judgedBy?: string; judgedEndpoint?: string; judgedApiKey?: string; enableJudge: boolean },
  handlers: ScenarioSuiteHandlers = {},
  signal?: AbortSignal,
): Promise<ScenarioSuiteResult> {
  const results = SCENARIOS.map(blankResult);
  const update = (): void => handlers.onScenarios?.(results.map((r) => ({ ...r })));

  if (config.warmupCards) {
    handlers.onProgress?.('Warming up GPUs…');
    await warmUpCards(config, signal);
  }

  handlers.onProgress?.('Measuring baseline latency…');
  const latencyMs = await measureBaselineLatency(config).catch(() => null);

  update();
  for (let i = 0; i < SCENARIOS.length; i++) {
    if (signal?.aborted) break;
    const def = SCENARIOS[i];
    const result = results[i];
    result.status = 'running';
    handlers.onProgress?.(`Scenario ${i + 1}/4: ${def.name}`);
    handlers.onLiveAnswer?.('');
    update();

    // Same-host fallback: when the engine API exposes no memory info
    // (llama.cpp, llama-swap, ...), sample live GPU stats from the OS
    // (nvidia-smi / sysfs) while the scenario generates.
    let gpuSampler: ReturnType<typeof setInterval> | null = null;
    let gpuPeakUsed = 0;
    let gpuTotal = 0;
    const utilSamples: number[] = [];
    if (result.memoryBytes === null && isSameHost(config.endpoint)) {
      let gpuName: string | null = null;
      try {
        gpuName = pickGpu(await getGpuStats())?.name ?? null;
      } catch {
        // Best-effort; the columns simply stay blank without a sampler.
      }
      if (gpuName) {
        gpuSampler = setInterval(() => {
          void getGpuStats()
            .then((stats) => {
              const g = stats.find((s) => s.name === gpuName);
              if (!g) return;
              gpuPeakUsed = Math.max(gpuPeakUsed, g.memoryUsedBytes);
              gpuTotal = g.memoryTotalBytes || gpuTotal;
              if (g.utilizationPercent !== null) utilSamples.push(g.utilizationPercent);
            })
            .catch(() => undefined);
        }, 1000);
      }
    }

    // One streamed generation per scenario at its fixed temperature.
    const acc = new MetricsAccumulator();
    acc.start();
    try {
      await streamCompletion(
        { ...config, systemPrompt: def.systemPrompt, prompt: def.prompt, temperature: def.temperature },
        (chunk) => {
          if (signal?.aborted) return;
          acc.ingest(chunk);
          for (const s of acc.takeNewSamples()) handlers.onSample?.(s);
          handlers.onLiveAnswer?.(acc.content);
        },
      );
      const metrics = applyLatencyAdjustment(acc.finalize(), latencyMs);
      result.status = 'done';
      result.metrics = metrics;
      result.response = stripThink(metrics.content);
      result.tps = metrics.tps ?? metrics.engineTps;
      result.ttftMs = metrics.ttftMs ?? metrics.ttfrMs;
      result.ppTps = metrics.ppTps;
    } catch (err) {
      result.status = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
      update();
      continue;
    } finally {
      if (gpuSampler) {
        clearInterval(gpuSampler);
        gpuSampler = null;
      }
    }

    // Memory / GPU split (Ollama only; blank on other engines).
    try {
      const probes = await probeEndpoint(config.endpoint, config.apiKey);
      const mem = findModelMemory(probes, config.model);
      if (mem) {
        result.memoryBytes = mem.totalBytes ?? null;
        result.vramBytes = mem.bytes || null;
        result.gpuPercent = mem.gpuPercent ?? null;
      }
    } catch {
      // Memory stats are best-effort; never fail a scenario over them.
    }
    // Fill from the local OS sampler when the engine API exposed nothing.
    if (result.memoryBytes === null) {
      result.memoryBytes = gpuPeakUsed > 0 ? gpuPeakUsed : null;
      result.gpuPercent =
        utilSamples.length > 0
          ? utilSamples.reduce((a, b) => a + b, 0) / utilSamples.length
          : null;
    }
    result.efficiency = efficiencyRatio(result.tps, result.vramBytes ?? result.memoryBytes);
    update();

    if (!opts.enableJudge || signal?.aborted) continue;

    // Judge the think-stripped answer with the judge model.
    result.status = 'judging';
    result.judgeModel = opts.judgedBy?.trim() || config.model;
    handlers.onProgress?.(`Judging ${def.name}…`);
    update();
    const { systemPrompt, prompt } = buildJudgePrompt(def, result.response);
    try {
      const judgeAcc = new MetricsAccumulator();
      judgeAcc.start();
      await streamCompletion(
        {
          ...config,
          // Judge can target a different OpenAI-compatible server; blank = same.
          endpoint: opts.judgedEndpoint?.trim() || config.endpoint,
          apiKey: opts.judgedApiKey?.trim() || config.apiKey,
          model: result.judgeModel,
          systemPrompt,
          prompt,
          temperature: 0,
          // Generous budget: thinking judges spend tokens on reasoning first.
          maxTokens: 2048,
        },
        (chunk) => judgeAcc.ingest(chunk),
        // No live UI for judge output.
      );
      const judgeText = stripThink(judgeAcc.finalize().content);
      const scores = parseJudgeScores(judgeText, def);
      if (scores === null) {
        const excerpt = judgeText.replace(/\s+/g, ' ').trim().slice(0, 120);
        result.judgeError = excerpt
          ? `Judge output not parseable: "${excerpt}…"`
          : 'Judge produced no output';
      } else {
        result.scores = scores;
        result.kpi = weightedKpi(def.dimensions, scores);
      }
    } catch (err) {
      result.judgeError = err instanceof Error ? err.message : String(err);
    }
    result.status = 'done';
    update();
  }

  const kpis = results.map((r) => r.kpi).filter((k): k is number => k !== null);
  handlers.onProgress?.('Scenarios complete.');
  return {
    id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: config.model,
    endpoint: config.endpoint,
    judged: opts.enableJudge,
    judgeModel: opts.enableJudge ? (opts.judgedBy?.trim() || config.model) : null,
    judgeEndpoint: opts.enableJudge ? (opts.judgedEndpoint?.trim() || config.endpoint) : null,
    startedAt: Date.now(),
    overallKpi: kpis.length > 0 ? kpis.reduce((a, b) => a + b, 0) / kpis.length : null,
    results,
  };
}
