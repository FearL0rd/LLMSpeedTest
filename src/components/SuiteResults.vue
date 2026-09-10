<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useSuiteStore } from '../stores/suite';
import { fmtStat, download, suiteToCsv, suiteToMarkdown } from '../engine/export';
import LineChart from './LineChart.vue';

const store = useSuiteStore();
const { result } = storeToRefs(store);

const rows = computed(() => result.value?.rows ?? []);

function testLabel(row: (typeof rows.value)[number]): string {
  if (row.kind === 'pp') return `pp${row.ppTarget}`;
  if (row.kind === 'tg') return `tg${row.tgCount}`;
  if (row.kind === 'ctx_pp') return 'ctx_pp';
  return 'ctx_tg';
}

/** pp rows report prompt-processing speed; tg rows report decode speed. */
function rowKindTps(row: (typeof rows.value)[number]) {
  return row.kind === 'pp' || row.kind === 'ctx_pp' ? row.stats.ppTps : row.stats.tps;
}

/** Hover diagnostics: explains blank cells when a server streams oddly. */
function diagTitle(row: (typeof rows.value)[number]): string {
  const first = row.runs[0];
  if (!first) return 'no completed runs';
  const d = first.diagnostics;
  return `stream: ${d.chunks} chunks, ${d.contentChunks} with tokens, ${d.usageChunks} with usage` +
    (d.contentChunks === 0 ? ' — server sent no token content; decode metrics unavailable' : '');
}

const depthSuffix = computed(() => {
  const depths = new Set(rows.value.map((r) => r.depth));
  return depths.size > 1 || (depths.has(0) === false && depths.size > 0);
});

/** tg tps / pp tps vs depth — the llama-bench signature curves. */
const depthSeries = computed(() => {
  const r = result.value;
  if (!r) return [];
  const byDepth = new Map<number, typeof rows.value>();
  for (const row of r.rows) {
    if (row.concurrency !== 1) continue;
    const list = byDepth.get(row.depth) ?? [];
    list.push(row);
    byDepth.set(row.depth, list);
  }
  return [...byDepth.entries()].map(([depth, list]) => ({
    name: `d${depth}`,
    points: list.map((row) => [
      row.kind === 'pp' || row.kind === 'ctx_pp' ? row.ppTarget : row.tgCount,
      row.stats.tps?.mean ?? 0,
    ] as [number, number]),
  })).filter((s) => s.points.length > 1);
});

/** Total throughput vs concurrency (tg rows). */
const concurrencySeries = computed(() => {
  const r = result.value;
  if (!r) return [];
  const groups = new Map<string, Array<[number, number]>>();
  for (const row of r.rows) {
    if (row.kind !== 'tg' || row.concurrency < 1) continue;
    const key = `d${row.depth}`;
    const list = groups.get(key) ?? [];
    if (row.totalTps) list.push([row.concurrency, row.totalTps.mean]);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([name, points]) => ({ name, points })).filter((s) => s.points.length > 1);
});

function exportResult(format: 'json' | 'csv' | 'md'): void {
  const r = result.value;
  if (!r) return;
  if (format === 'json') {
    download(`speedtest-suite-${r.id}.json`, JSON.stringify(r, null, 2), 'application/json');
  } else if (format === 'csv') {
    download(`speedtest-suite-${r.id}.csv`, suiteToCsv(r), 'text/csv');
  } else {
    download(`speedtest-suite-${r.id}.md`, suiteToMarkdown(r), 'text/markdown');
  }
}
</script>

<template>
  <section class="panel results-panel" data-testid="suite-results">
    <div v-if="!result" class="empty">
      No suite results yet. Configure a matrix on the left and run the suite.
    </div>

    <template v-else>
      <div class="result-header">
        <div>
          <div class="title">{{ result.label }} <span class="muted">· {{ result.model }}</span></div>
          <div class="muted meta">
            latency mode: {{ result.latencyMode }}
            <template v-if="result.latencyMs !== null"> ({{ result.latencyMs.toFixed(1) }} ms baseline)</template>
            <template v-if="result.coherenceOk !== null">
              · coherence: <span :class="result.coherenceOk ? 'ok' : 'fail'">{{ result.coherenceOk ? 'OK' : 'FAILED' }}</span>
            </template>
          </div>
        </div>
        <div class="export-btns">
          <button data-testid="export-json" @click="exportResult('json')">JSON</button>
          <button data-testid="export-csv" @click="exportResult('csv')">CSV</button>
          <button data-testid="export-md" @click="exportResult('md')">Markdown</button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="runs-table">
          <thead>
            <tr>
              <th>Test</th>
              <th class="num">t/s</th>
              <th class="num">Peak t/s (1s)</th>
              <th class="num">TTFR (ms)</th>
              <th class="num">TTFT (ms)</th>
              <th class="num">est_ppt (ms)</th>
              <th class="num">TPOT (ms)</th>
              <th v-if="concurrencySeries.length > 0" class="num">Total t/s</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key" :data-testid="`row-${row.kind}`">
              <td class="label-cell" :title="diagTitle(row)">
                {{ testLabel(row) }}<template v-if="depthSuffix"> @ d{{ row.depth }}</template><template v-if="row.concurrency > 1"> c{{ row.concurrency }}</template>
              </td>
              <td class="num">{{ fmtStat(rowKindTps(row)) }}</td>
              <td class="num">{{ fmtStat(row.kind === 'pp' || row.kind === 'ctx_pp' ? undefined : row.stats.peakWindowTps) }}</td>
              <td class="num">{{ fmtStat(row.stats.ttfrMs) }}</td>
              <td class="num">{{ fmtStat(row.stats.ttftMs) }}</td>
              <td class="num">{{ fmtStat(row.stats.estPptMs) }}</td>
              <td class="num">{{ fmtStat(row.stats.tpotMs) }}</td>
              <td v-if="concurrencySeries.length > 0" class="num">{{ fmtStat(row.totalTps ?? undefined) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="concurrencySeries.length > 0" class="chart-block">
        <div class="block-title">Throughput vs Concurrency</div>
        <LineChart :series="concurrencySeries" x-name="concurrent requests" y-name="tok/s" />
      </div>

      <div v-if="depthSeries.length > 1" class="chart-block">
        <div class="block-title">Throughput by Context Depth</div>
        <LineChart :series="depthSeries" x-name="tokens" y-name="tok/s" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.results-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-width: 0;
}
.empty {
  color: var(--muted);
  font-size: 13px;
  padding: 24px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  text-align: center;
}
.result-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.muted {
  color: var(--muted);
}
.meta {
  font-size: 12px;
  margin-top: 2px;
}
.ok {
  color: var(--ok);
}
.fail {
  color: var(--danger);
}
.export-btns {
  display: flex;
  gap: 6px;
}
.export-btns button {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
.export-btns button:hover {
  border-color: var(--accent);
}
.table-wrap {
  overflow-x: auto;
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
.label-cell {
  color: var(--text);
}
.chart-block {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--panel);
}
.block-title {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
}
</style>