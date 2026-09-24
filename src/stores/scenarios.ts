import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  runScenarioSuite,
  type ScenarioResult,
  type ScenarioSuiteResult,
} from '../engine/scenarioRunner';
import { SCENARIOS } from '../engine/scenarios';
import { useBenchmarkStore } from './benchmark';

const PREFS_KEY = 'llm-speedtest.scenarios.v1';

function loadPrefs(): { judgeEnabled: boolean; judgeModel: string; judgeEndpoint: string } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { judgeEnabled: false, judgeModel: '', judgeEndpoint: '' };
    const parsed: unknown = JSON.parse(raw);
    const p = parsed as { judgeEnabled?: unknown; judgeModel?: unknown; judgeEndpoint?: unknown };
    return {
      judgeEnabled: p?.judgeEnabled === true,
      judgeModel: typeof p?.judgeModel === 'string' ? p.judgeModel : '',
      judgeEndpoint: typeof p?.judgeEndpoint === 'string' ? p.judgeEndpoint : '',
    };
  } catch {
    return { judgeEnabled: false, judgeModel: '', judgeEndpoint: '' };
  }
}

export const useScenarioStore = defineStore('scenarios', () => {
  const bench = useBenchmarkStore();

  const prefs = reactive(loadPrefs());
  const running = ref(false);
  const progressLabel = ref('');
  const liveAnswer = ref('');
  const scenarioResults = ref<ScenarioResult[]>(
    SCENARIOS.map((d) => ({
      scenarioId: d.id,
      name: d.name,
      focus: d.focus,
      temperature: d.temperature,
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
    })),
  );
  const suiteResult = ref<ScenarioSuiteResult | null>(null);
  const error = ref<string | null>(null);
  let abort: AbortController | null = null;

  const overallKpi = computed(() => suiteResult.value?.overallKpi ?? null);
  const completedCount = computed(
    () => scenarioResults.value.filter((r) => r.status === 'done').length,
  );

  function persistPrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (err) {
      console.error('Failed to persist scenario prefs', err);
    }
  }

  async function run(): Promise<void> {
    if (running.value) return;
    running.value = true;
    error.value = null;
    suiteResult.value = null;
    abort = new AbortController();
    persistPrefs();
    try {
      suiteResult.value = await runScenarioSuite(
        { ...bench.config },
        { enableJudge: prefs.judgeEnabled, judgedBy: prefs.judgeModel, judgedEndpoint: prefs.judgeEndpoint },
        {
          onProgress: (label) => {
            progressLabel.value = label;
          },
          onScenarios: (list) => {
            scenarioResults.value = list;
          },
          onLiveAnswer: (text) => {
            liveAnswer.value = text;
          },
        },
        abort.signal,
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      running.value = false;
      abort = null;
    }
  }

  function cancel(): void {
    abort?.abort();
    running.value = false;
    progressLabel.value = 'Cancelled.';
  }

  return {
    prefs,
    running,
    progressLabel,
    liveAnswer,
    scenarioResults,
    suiteResult,
    overallKpi,
    completedCount,
    error,
    run,
    cancel,
  };
});
