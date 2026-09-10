import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { runSuite } from '../engine/runner';
import type { SuiteConfig, SuiteProgress, SuiteResult } from '../engine/runner';
import type { StreamConfig } from '../types';
import { useBenchmarkStore } from './benchmark';

const SUITE_KEY = 'llm-speedtest.suiteConfig.v1';

function defaultSuiteConfig(): SuiteConfig {
  return {
    ppTargets: [512],
    tgCounts: [64],
    depths: [0],
    concurrencyLevels: [1],
    runs: 2,
    warmup: 1,
    exactTg: false,
    prefixCaching: false,
    coherence: true,
  };
}

function loadSuiteConfig(): SuiteConfig {
  try {
    const raw = localStorage.getItem(SUITE_KEY);
    if (!raw) return defaultSuiteConfig();
    const parsed = JSON.parse(raw) as Partial<SuiteConfig>;
    return { ...defaultSuiteConfig(), ...parsed };
  } catch {
    return defaultSuiteConfig();
  }
}

function parseList(value: string, fallback: number[]): number[] {
  const nums = value
    .split(/[,\s]+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? [...new Set(nums)] : fallback;
}

export const useSuiteStore = defineStore('suite', () => {
  const benchmark = useBenchmarkStore();
  const suiteConfig = reactive<SuiteConfig>(loadSuiteConfig());

  // Text fields backing the comma-separated number lists.
  const ppText = ref(suiteConfig.ppTargets.join(', '));
  const tgText = ref(suiteConfig.tgCounts.join(', '));
  const depthText = ref(suiteConfig.depths.join(', '));
  const concText = ref(suiteConfig.concurrencyLevels.join(', '));

  const running = ref(false);
  const progress = ref<SuiteProgress>({ done: 0, total: 0, label: '' });
  const result = ref<SuiteResult | null>(null);
  const error = ref<string | null>(null);
  let abort: AbortController | null = null;

  const progressPct = computed(() =>
    progress.value.total > 0 ? Math.min(100, (progress.value.done / progress.value.total) * 100) : 0,
  );

  function persistConfig(): void {
    try {
      localStorage.setItem(SUITE_KEY, JSON.stringify(suiteConfig));
    } catch {
      /* best effort */
    }
  }

  function syncLists(): void {
    suiteConfig.ppTargets = parseList(ppText.value, [512]);
    suiteConfig.tgCounts = parseList(tgText.value, [64]);
    suiteConfig.depths = parseList(depthText.value, [0]);
    suiteConfig.concurrencyLevels = parseList(concText.value, [1]);
    persistConfig();
  }

  function buildStreamConfig(): StreamConfig {
    const c = benchmark.config;
    return {
      endpoint: c.endpoint,
      apiKey: c.apiKey,
      model: c.model,
      prompt: c.prompt,
      systemPrompt: c.systemPrompt,
      temperature: c.temperature,
      includeUsage: c.includeUsage,
      label: c.label,
      latencyMode: c.latencyMode ?? 'generation',
    };
  }

  async function run(): Promise<void> {
    if (running.value) return;
    const base = buildStreamConfig();
    if (!base.endpoint || !base.model) {
      error.value = 'Endpoint and model are required';
      return;
    }
    syncLists();
    running.value = true;
    error.value = null;
    result.value = null;
    progress.value = { done: 0, total: 1, label: 'Starting…' };
    abort = new AbortController();
    try {
      result.value = await runSuite(base, { ...suiteConfig }, {
        onProgress: (p) => {
          progress.value = p;
        },
      }, abort.signal);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      running.value = false;
      abort = null;
    }
  }

  function cancel(): void {
    abort?.abort();
  }

  function importSuite(json: string): void {
    const parsed = JSON.parse(json) as Partial<SuiteResult>;
    if (!parsed || !Array.isArray(parsed.rows) || typeof parsed.model !== 'string') {
      throw new Error('Not a suite result file');
    }
    result.value = parsed as SuiteResult;
  }

  return {
    suiteConfig,
    ppText,
    tgText,
    depthText,
    concText,
    running,
    progress,
    progressPct,
    result,
    error,
    run,
    cancel,
    syncLists,
    importSuite,
  };
});