import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { MetricsAccumulator, runLabel } from '../engine/metrics';
import { applyLatencyAdjustment } from '../engine/runner';
import { measureBaselineLatency } from '../engine/latency';
import { streamCompletion } from '../engine/streaming';
import {
  detectEngine,
  getSystemInfo,
  isSameHost,
  probeEndpoint,
  summarizeSystem,
} from '../engine/probe';
import type { EngineInfo, ProbeResult } from '../engine/probe';
import type {
  RawChunk,
  RunMetrics,
  RunStatus,
  SavedRun,
  SpeedSample,
  StreamConfig,
  SystemInfo,
} from '../types';

const STORAGE_KEY = 'llm-speedtest.runs.v1';

function defaultConfig(): StreamConfig {
  return {
    endpoint: 'http://localhost:11434',
    apiKey: '',
    model: '',
    systemPrompt: '',
    prompt:
      'Write a comprehensive, 800-word technical explanation of the complete lifecycle of a high-mass star, from stellar nebula to supernova. Break down the processes of nuclear fusion, hydrostatic equilibrium, and main sequence evolution into detailed, multi-paragraph sections. Do not summarize; provide a deep, sustained dive into the physics.',
    temperature: 0.7,
    maxTokens: undefined,
    label: '',
    hardware: '',
    latencyMode: 'generation',
    includeUsage: true,
  };
}

function loadSavedRuns(): SavedRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedRun[]) : [];
  } catch {
    return [];
  }
}

export const useBenchmarkStore = defineStore('benchmark', () => {
  const config = reactive<StreamConfig>(defaultConfig());

  const status = ref<RunStatus>('idle');
  const error = ref<string | null>(null);
  const elapsedMs = ref(0);
  const latencyMs = ref<number | null>(null);
  const liveContent = ref('');
  const liveSamples = ref<SpeedSample[]>([]);
  const liveTtftMs = ref<number | null>(null);
  const currentRun = ref<RunMetrics | null>(null);
  const savedRuns = ref<SavedRun[]>(loadSavedRuns());
  const compareIds = ref<string[]>([]);

  const probing = ref(false);
  const probeError = ref<string | null>(null);
  const probeInfo = ref<{ engine: EngineInfo; probes: ProbeResult[] } | null>(null);
  const systemInfo = ref<SystemInfo | null>(null);
  const sameHost = ref(false);

  const modelSuggestions = computed(() => probeInfo.value?.engine.models ?? []);
  let runToken = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const compareRuns = computed(() =>
    compareIds.value
      .map((id) => savedRuns.value.find((r) => r.id === id))
      .filter((r): r is SavedRun => r !== undefined),
  );

  const isRunning = computed(() => status.value === 'running');

  function persistRuns(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRuns.value));
    } catch (err) {
      console.error('Failed to persist runs', err);
    }
  }

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  async function runBenchmark(): Promise<void> {
    if (isRunning.value) return;
    const token = ++runToken;
    // Sanitize numeric inputs: empty <input type=number> yields '' at runtime.
    const snapshot: StreamConfig = {
      ...config,
      temperature:
        typeof config.temperature === 'number' && Number.isFinite(config.temperature)
          ? config.temperature
          : undefined,
      maxTokens:
        typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens) && config.maxTokens > 0
          ? Math.round(config.maxTokens)
          : undefined,
    };

    status.value = 'running';
    error.value = null;
    currentRun.value = null;
    liveContent.value = '';
    liveSamples.value = [];
    liveTtftMs.value = null;
    elapsedMs.value = 0;

    // Baseline latency probe (network + server overhead) for est_ppt / pp tps.
    latencyMs.value = await measureBaselineLatency(snapshot);
    if (token !== runToken) return;

    const acc = new MetricsAccumulator();
    acc.start();
    const startWall = Date.now();
    stopTicker();
    ticker = setInterval(() => {
      elapsedMs.value = Date.now() - startWall;
    }, 100);

    const onChunk = (chunk: RawChunk): void => {
      if (token !== runToken) return;
      acc.ingest(chunk);
      liveSamples.value = [...liveSamples.value, ...acc.takeNewSamples()];
      liveContent.value = acc.content;
      const ttft = acc.ttftMs;
      if (ttft !== null) liveTtftMs.value = ttft;
    };

    try {
      await streamCompletion(snapshot, onChunk);
      if (token !== runToken) return;
      currentRun.value = applyLatencyAdjustment(acc.finalize(), latencyMs.value);
      status.value = 'done';
    } catch (err) {
      if (token !== runToken) return;
      error.value = err instanceof Error ? err.message : String(err);
      currentRun.value = applyLatencyAdjustment(acc.finalize(), latencyMs.value);
      status.value = 'error';
    } finally {
      if (token === runToken) {
        stopTicker();
        elapsedMs.value = Date.now() - startWall;
      }
    }
  }

  function cancelRun(): void {
    if (!isRunning.value) return;
    runToken += 1;
    stopTicker();
    status.value = 'idle';
  }

  function saveCurrentRun(): void {
    const metrics = currentRun.value;
    if (!metrics) return;
    const run: SavedRun = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: runLabel(config),
      model: config.model,
      endpoint: config.endpoint,
      hardware: config.hardware?.trim() || undefined,
      createdAt: Date.now(),
      config: { ...config },
      metrics,
    };
    savedRuns.value = [run, ...savedRuns.value];
    persistRuns();
  }

  /**
   * Probe the configured endpoint for engine identity and, when it is served
   * by this same machine, local hardware. Auto-fills the hardware field when
   * it is still empty; remote endpoints keep whatever the user typed.
   */
  async function detectEndpoint(): Promise<void> {
    if (probing.value) return;
    const endpoint = config.endpoint.trim();
    if (!endpoint) return;
    probing.value = true;
    probeError.value = null;
    try {
      const probes = await probeEndpoint(endpoint, config.apiKey);
      const engine = detectEngine(probes);
      probeInfo.value = { engine, probes };
      sameHost.value = isSameHost(endpoint);
      if (sameHost.value) {
        systemInfo.value = await getSystemInfo();
      }
      if (!config.hardware || config.hardware.trim().length === 0) {
        const parts: string[] = [];
        if (sameHost.value && systemInfo.value) {
          parts.push(summarizeSystem(systemInfo.value));
        }
        if (engine.engine) {
          parts.push(engine.version ? `${engine.engine} ${engine.version}` : engine.engine);
        }
        config.hardware = parts.join(' · ');
      }
    } catch (err) {
      probeError.value = err instanceof Error ? err.message : String(err);
    } finally {
      probing.value = false;
    }
  }

  function deleteRun(id: string): void {
    savedRuns.value = savedRuns.value.filter((r) => r.id !== id);
    compareIds.value = compareIds.value.filter((cid) => cid !== id);
    persistRuns();
  }

  /** Merge runs from an imported file, deduplicating by id. */
  function addImportedRun(run: SavedRun): void {
    if (savedRuns.value.some((r) => r.id === run.id)) return;
    savedRuns.value = [run, ...savedRuns.value];
    persistRuns();
  }

  function toggleCompare(id: string): void {
    compareIds.value = compareIds.value.includes(id)
      ? compareIds.value.filter((cid) => cid !== id)
      : [...compareIds.value, id];
  }

  return {
    config,
    status,
    error,
    elapsedMs,
    latencyMs,
    liveContent,
    liveSamples,
    liveTtftMs,
    currentRun,
    savedRuns,
    compareIds,
    compareRuns,
    isRunning,
    probing,
    probeError,
    probeInfo,
    systemInfo,
    sameHost,
    modelSuggestions,
    runBenchmark,
    cancelRun,
    saveCurrentRun,
    deleteRun,
    addImportedRun,
    toggleCompare,
    detectEndpoint,
  };
});