<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBenchmarkStore } from '../stores/benchmark';
import { useScenarioStore } from '../stores/scenarios';
import { download, scenariosToCsv, scenariosToMarkdown } from '../engine/export';
import { formatBytes } from '../engine/probe';

const bench = useBenchmarkStore();
const store = useScenarioStore();
const { config } = storeToRefs(bench);
const {
  prefs,
  running,
  progressLabel,
  liveAnswer,
  scenarioResults,
  suiteResult,
  overallKpi,
  completedCount,
  error,
} = storeToRefs(store);

const exportError = ref<string | null>(null);

const canRun = computed(
  () => !!config.value.endpoint && !!config.value.model && !running.value,
);
const useSameModel = computed(() => prefs.value.judgeModel.trim().length === 0);

function num(v: number | null, digits = 1): string {
  return v === null ? '—' : v.toFixed(digits);
}

async function exportResult(format: 'json' | 'csv' | 'md'): Promise<void> {
  const r = suiteResult.value;
  if (!r) return;
  try {
    if (format === 'json') {
      await download(`speedtest-scenarios-${r.id}.json`, JSON.stringify(r, null, 2), 'application/json');
    } else if (format === 'csv') {
      await download(`speedtest-scenarios-${r.id}.csv`, scenariosToCsv(r), 'text/csv');
    } else {
      await download(`speedtest-scenarios-${r.id}.md`, scenariosToMarkdown(r), 'text/markdown');
    }
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err);
    setTimeout(() => (exportError.value = null), 6000);
  }
}
</script>

<template>
  <div class="scenarios-view">
    <section class="panel controls">
      <div class="head">
        <div>
          <h2>Scenario Benchmarks</h2>
          <div class="sub">
            Four fixed tasks — Agent Workflow, Code Generation, Role Play &amp; Narrative,
            Research &amp; Analysis — each at its own temperature, llm-bench style.
            Set the endpoint + model on the Benchmark tab first. Memory / GPU % /
            t-s-per-GB fill in on Ollama endpoints (via /api/ps); other engines
            don't expose them, so those cells stay blank rather than guessed.
          </div>
        </div>
        <div v-if="suiteResult" class="export-btns">
          <button data-testid="export-json" @click="exportResult('json')">JSON</button>
          <button data-testid="export-csv" @click="exportResult('csv')">CSV</button>
          <button data-testid="export-md" @click="exportResult('md')">Markdown</button>
        </div>
      </div>

      <div class="opt-row">
        <label class="check">
          <input
            v-model="prefs.judgeEnabled"
            type="checkbox"
            :disabled="running"
            data-testid="judge-enabled"
          />
          <span>Score answers with an LLM judge (quality KPI per scenario)</span>
        </label>
        <input
          v-if="prefs.judgeEnabled"
          v-model="prefs.judgeModel"
          class="judge-model"
          type="text"
          placeholder="Judge model (blank = same model)"
          :disabled="running"
          data-testid="judge-model"
        />
      </div>
      <p v-if="prefs.judgeEnabled && useSameModel" class="hint" data-testid="self-judge-hint">
        No judge model set — the model under test grades its own answers. Prefer a strong
        separate judge when you can.
      </p>

      <div class="run-row">
        <button
          v-if="!running"
          class="primary"
          :disabled="!canRun"
          data-testid="run-scenarios"
          @click="store.run()"
        >
          ▶ Run Scenarios
        </button>
        <button v-else class="danger" data-testid="cancel-scenarios" @click="store.cancel()">
          ■ Cancel
        </button>
        <div class="progress" data-testid="scenario-progress">
          {{ progressLabel }}<template v-if="running"> · {{ completedCount }}/4 done</template>
        </div>
      </div>

      <!-- Live answer while a scenario is generating -->
      <div v-if="running && liveAnswer" class="live" data-testid="live-answer">
        <div class="live-label">generating…</div>
        <pre>{{ liveAnswer.slice(-1600) }}</pre>
      </div>

      <div v-if="error" class="error-banner" data-testid="scenario-error">{{ error }}</div>
      <div v-if="exportError" class="error-banner" data-testid="export-error">
        Export failed: {{ exportError }}
      </div>
    </section>

    <section class="panel results">
      <table class="runs-table">
        <thead>
          <tr>
            <th>Scenario</th>
            <th class="num">Temp</th>
            <th class="num">t/s</th>
            <th class="num">PP t/s</th>
            <th class="num">TTFT (ms)</th>
            <th class="num">Tokens</th>
            <th class="num">Memory</th>
            <th class="num">GPU %</th>
            <th class="num">t/s per GB</th>
            <th class="num">KPI</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in scenarioResults" :key="r.scenarioId" :data-testid="`row-${r.scenarioId}`">
            <td class="label-cell">
              <div class="scenario-name">{{ r.name }}</div>
              <div class="scenario-focus">{{ r.focus }}</div>
              <div v-if="r.error" class="row-error">{{ r.error }}</div>
              <div v-else-if="r.judgeError" class="row-error">judge: {{ r.judgeError }}</div>
              <div v-else class="scenario-status" :class="r.status">
                {{ r.status === 'pending' ? '·' : r.status }}
              </div>
            </td>
            <td class="num">{{ num(r.temperature) }}</td>
            <td class="num">{{ num(r.tps) }}</td>
            <td class="num">{{ num(r.ppTps, 0) }}</td>
            <td class="num">{{ num(r.ttftMs, 0) }}</td>
            <td class="num">{{ r.metrics?.completionTokens ?? '—' }}</td>
            <td class="num">{{ r.vramBytes || r.memoryBytes ? formatBytes(r.vramBytes ?? r.memoryBytes) : '—' }}</td>
            <td class="num">{{ r.gpuPercent !== null ? `${r.gpuPercent}%` : '—' }}</td>
            <td class="num">{{ r.efficiency !== null ? r.efficiency.toFixed(2) : '—' }}</td>
            <td class="num kpi">{{ r.kpi !== null ? r.kpi.toFixed(0) : '—' }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="suiteResult" class="summary" data-testid="scenario-summary">
        <span v-if="overallKpi !== null" class="chip kpi-chip">
          Overall KPI {{ overallKpi.toFixed(1) }}
        </span>
        <span class="chip">{{ suiteResult.model }}</span>
        <span v-if="suiteResult.judgeModel" class="chip dim">judged by {{ suiteResult.judgeModel }}</span>
        <span v-else class="chip dim">quality scoring off</span>
      </div>

      <!-- Per-scenario detail: judge dimensions + full response -->
      <details
        v-for="r in scenarioResults.filter((x) => x.status === 'done')"
        :key="`detail-${r.scenarioId}`"
        class="detail"
        :data-testid="`detail-${r.scenarioId}`"
      >
        <summary>{{ r.name }} — answer &amp; judge detail</summary>
        <div v-if="r.scores" class="scores">
          <div v-for="(v, k) in r.scores" :key="k" class="score-row">
            <span class="dim-key">{{ k }}</span>
            <div class="score-bar"><div class="score-fill" :style="{ width: `${v}%` }"></div></div>
            <span class="num">{{ v }}</span>
          </div>
        </div>
        <pre class="answer">{{ r.response || '(empty response)' }}</pre>
      </details>
    </section>
  </div>
</template>

<style scoped>
.scenarios-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
h2 {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 4px;
}
.sub {
  font-size: 12px;
  color: var(--muted);
  max-width: 640px;
  line-height: 1.5;
}
.opt-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.check input {
  width: auto;
  accent-color: var(--accent);
}
.judge-model {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 7px 10px;
  font-size: 12px;
  min-width: 240px;
}
.judge-model:focus {
  outline: none;
  border-color: var(--accent);
}
.hint {
  font-size: 11px;
  color: var(--muted);
  opacity: 0.85;
  margin: 0;
}
.run-row {
  display: flex;
  gap: 12px;
  align-items: center;
}
button {
  border: 1px solid var(--border);
  background: var(--bg-inset);
  color: var(--text);
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  cursor: pointer;
}
button:hover:not(:disabled) {
  border-color: var(--accent);
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
button.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
button.danger {
  border-color: var(--danger);
  color: var(--danger);
}
.progress {
  font-size: 12px;
  color: var(--muted);
}
.live {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-inset);
  padding: 8px 10px;
}
.live-label {
  font-size: 11px;
  color: var(--accent);
  margin-bottom: 4px;
}
.live pre {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  white-space: pre-wrap;
  max-height: 140px;
  overflow-y: auto;
}
.error-banner {
  color: var(--danger);
  font-size: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  padding: 8px 10px;
}
.runs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.runs-table th,
.runs-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.runs-table th {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.runs-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.scenario-name {
  font-weight: 600;
  font-size: 13px;
}
.scenario-focus {
  font-size: 11px;
  color: var(--muted);
}
.scenario-status {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.scenario-status.running {
  color: var(--accent);
}
.scenario-status.judging {
  color: var(--warn);
}
.scenario-status.done {
  color: var(--ok);
}
.scenario-status.failed {
  color: var(--danger);
}
.row-error {
  font-size: 11px;
  color: var(--danger);
  max-width: 260px;
}
.kpi {
  font-weight: 700;
}
.summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-inset);
  color: var(--text);
}
.chip.dim {
  color: var(--muted);
}
.kpi-chip {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 700;
}
.detail {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.detail summary {
  cursor: pointer;
  color: var(--text);
  font-weight: 600;
}
.detail summary:hover {
  color: var(--accent);
}
.scores {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
}
.score-row {
  display: grid;
  grid-template-columns: 150px 1fr 40px;
  gap: 10px;
  align-items: center;
  font-size: 11.5px;
}
.dim-key {
  color: var(--muted);
}
.score-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-inset);
  overflow: hidden;
}
.score-fill {
  height: 100%;
  background: var(--accent);
}
.answer {
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--muted);
  max-height: 320px;
  overflow-y: auto;
  margin: 8px 0 4px;
}
.export-btns {
  display: flex;
  gap: 6px;
}
</style>
