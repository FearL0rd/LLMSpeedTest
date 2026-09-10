<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBenchmarkStore } from '../stores/benchmark';
import { fmt } from '../engine/metrics';
import { download, parseImportedRuns, runsToCsv } from '../engine/export';
import SpeedChart from './SpeedChart.vue';

const store = useBenchmarkStore();
const { savedRuns, compareIds, compareRuns } = storeToRefs(store);
const importError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const chartSeries = computed(() =>
  compareRuns.value.map((r) => ({
    name: r.label,
    samples: r.metrics.samples,
  })),
);

function dateLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

function exportCsv(): void {
  if (savedRuns.value.length > 0) {
    download('speedtest-runs.csv', runsToCsv(savedRuns.value), 'text/csv');
  }
}

function exportJson(): void {
  if (savedRuns.value.length > 0) {
    download('speedtest-runs.json', JSON.stringify(savedRuns.value, null, 2), 'application/json');
  }
}

function onImportFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const runs = parseImportedRuns(String(reader.result));
      for (const run of runs) store.addImportedRun(run);
      importError.value = null;
    } catch (err) {
      importError.value = err instanceof Error ? err.message : String(err);
    }
  };
  reader.readAsText(file);
}
</script>

<template>
  <section class="panel compare-panel" data-testid="compare-view">
    <div class="saved-list">
      <div class="list-header">
        <div class="block-title">Saved Runs</div>
        <div class="io-btns">
          <button data-testid="import-runs" @click="fileInput?.click()">Import</button>
          <button :disabled="savedRuns.length === 0" data-testid="export-json-runs" @click="exportJson()">JSON</button>
          <button :disabled="savedRuns.length === 0" data-testid="export-csv-runs" @click="exportCsv()">CSV</button>
          <input
            ref="fileInput"
            type="file"
            accept=".json,application/json"
            style="display: none"
            @change="onImportFile"
          />
        </div>
      </div>
      <div v-if="importError" class="import-error">{{ importError }}</div>
      <div v-if="savedRuns.length === 0" class="empty">
        No saved runs yet. Run a benchmark and click “Save Run” to build comparison profiles.
      </div>
      <table v-else class="runs-table">
        <thead>
          <tr>
            <th></th>
            <th>Label</th>
            <th>Model</th>
            <th>Hardware</th>
            <th class="num">TTFT</th>
            <th class="num">TPS</th>
            <th class="num">PP t/s</th>
            <th class="num">TPOT</th>
            <th class="num">Tokens</th>
            <th>Saved</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in savedRuns" :key="r.id" :class="{ selected: compareIds.includes(r.id) }">
            <td>
              <input
                type="checkbox"
                :checked="compareIds.includes(r.id)"
                :data-testid="`compare-${r.id}`"
                @change="store.toggleCompare(r.id)"
              />
            </td>
            <td class="label-cell">{{ r.label }}</td>
            <td class="muted">{{ r.model }}</td>
            <td class="muted hw-cell" :data-testid="`hw-${r.id}`">{{ r.hardware || '—' }}</td>
            <td class="num">{{ fmt(r.metrics.ttftMs, 0, ' ms') }}</td>
            <td class="num">{{ fmt(r.metrics.tps, 1) }}</td>
            <td class="num">{{ fmt(r.metrics.ppTps, 0) }}</td>
            <td class="num">{{ fmt(r.metrics.tpotMs, 2, ' ms') }}</td>
            <td class="num">{{ r.metrics.totalTokens ?? '—' }}</td>
            <td class="muted">{{ dateLabel(r.createdAt) }}</td>
            <td>
              <button class="delete" :data-testid="`delete-${r.id}`" @click="store.deleteRun(r.id)">
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="compareRuns.length > 0" class="compare-block">
      <div class="block-title">Speed Comparison ({{ compareRuns.length }} runs)</div>
      <SpeedChart :series="chartSeries" height="300px" />

      <table class="metrics-table">
        <thead>
          <tr>
            <th>Run</th>
            <th class="num">TTFT (ms)</th>
            <th class="num">TPS</th>
            <th class="num">TPOT (ms)</th>
            <th class="num">Peak TPS</th>
            <th class="num">Mean TPS</th>
            <th class="num">Min TPS</th>
            <th class="num">Prompt</th>
            <th class="num">Completion</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in compareRuns" :key="r.id">
            <td class="label-cell">{{ r.label }}</td>
            <td class="num">{{ fmt(r.metrics.ttftMs, 0) }}</td>
            <td class="num">{{ fmt(r.metrics.tps, 1) }}</td>
            <td class="num">{{ fmt(r.metrics.tpotMs, 2) }}</td>
            <td class="num">{{ fmt(r.metrics.peakTps, 1) }}</td>
            <td class="num">{{ fmt(r.metrics.meanTps, 1) }}</td>
            <td class="num">{{ fmt(r.metrics.minTps, 1) }}</td>
            <td class="num">{{ r.metrics.promptTokens ?? '—' }}</td>
            <td class="num">{{ r.metrics.completionTokens ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.compare-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
  min-width: 0;
}
.block-title {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
}
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.io-btns {
  display: flex;
  gap: 6px;
}
.io-btns button {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.io-btns button:hover:not(:disabled) {
  border-color: var(--accent);
}
.io-btns button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.import-error {
  color: var(--danger);
  font-size: 12px;
  margin-bottom: 8px;
}
.empty {
  color: var(--muted);
  font-size: 13px;
  padding: 24px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  text-align: center;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--muted);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
td.num,
th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
tr.selected td {
  background: rgba(86, 156, 255, 0.07);
}
.label-cell {
  color: var(--text);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.muted {
  color: var(--muted);
}
.hw-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.delete {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
}
.delete:hover {
  color: var(--danger);
}
.compare-block {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  background: var(--panel);
}
.metrics-table {
  margin-top: 14px;
}
</style>