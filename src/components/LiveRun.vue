<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useBenchmarkStore } from '../stores/benchmark';
import { fmt } from '../engine/metrics';
import KpiCard from './KpiCard.vue';
import SpeedChart from './SpeedChart.vue';

const store = useBenchmarkStore();
const {
  status,
  error,
  elapsedMs,
  latencyMs,
  liveSamples,
  liveTtftMs,
  liveContent,
  currentRun,
  isRunning,
} = storeToRefs(store);

const run = computed(() => currentRun.value);
const chartSeries = computed(() => [{ name: 'Throughput', samples: liveSamples.value }]);

const ttft = computed(() => (run.value ? run.value.ttftMs : liveTtftMs.value));
const decodeTime = computed(() => (run.value ? run.value.decodeTimeMs : null));
const peak = computed(() => run.value?.peakWindowTps ?? run.value?.peakTps ?? null);

const engineNote = computed(() => {
  if (!run.value) return undefined;
  if (run.value.engineTps !== null) {
    return `engine: ${fmt(run.value.engineTps, 1, ' tok/s')} · TTFT ${fmt(run.value.engineTtftMs, 0, 'ms')}`;
  }
  return undefined;
});

function statusLabel(): string {
  switch (status.value) {
    case 'running':
      return 'Streaming…';
    case 'done':
      return 'Complete';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}
</script>

<template>
  <section class="panel live-panel" data-testid="live-run">
    <div class="live-header">
      <span class="badge" :class="status" data-testid="status">
        <span v-if="isRunning" class="pulse"></span>
        {{ statusLabel() }}
      </span>
      <span class="elapsed" data-testid="elapsed">{{ fmt(elapsedMs / 1000, 2, 's') }}</span>
      <button
        v-if="run && status === 'done'"
        class="save"
        data-testid="save-btn"
        @click="store.saveCurrentRun()"
      >
        ＋ Save Run
      </button>
    </div>

    <div v-if="error" class="error-banner" data-testid="error-banner">{{ error }}</div>

    <div class="kpi-grid">
      <KpiCard
        label="TTFT"
        :value="fmt(ttft, 0, ' ms')"
        sub="first content token"
        highlight
        data-testid="kpi-ttft"
      />
      <KpiCard
        label="TTFR"
        :value="fmt(run?.ttfrMs, 0, ' ms')"
        :sub="latencyMs !== null ? `baseline ${fmt(latencyMs, 0, ' ms')}` : 'first response chunk'"
        data-testid="kpi-ttfr"
      />
      <KpiCard
        label="TPS"
        :value="fmt(run?.tps, 1, ' tok/s')"
        sub="decode throughput"
        data-testid="kpi-tps"
      />
      <KpiCard
        label="PP Speed"
        :value="fmt(run?.ppTps, 0, ' tok/s')"
        sub="prompt processing"
        data-testid="kpi-pp"
      />
      <KpiCard
        label="TPOT"
        :value="fmt(run?.tpotMs, 2, ' ms')"
        sub="per output token"
        data-testid="kpi-tpot"
      />
      <KpiCard
        label="Peak Speed"
        :value="fmt(peak, 1, ' tok/s')"
        :sub="`1s window · mean ${fmt(run?.meanTps, 1)} · min ${fmt(run?.minTps, 1)}`"
        data-testid="kpi-peak"
      />
      <KpiCard
        label="Prompt Tokens"
        :value="run?.promptTokens !== null && run?.promptTokens !== undefined ? String(run.promptTokens) : '—'"
        :sub="run?.estPptMs !== null && run?.estPptMs !== undefined ? `est. ppt ${fmt(run.estPptMs, 0, ' ms')}` : 'prefill'"
        data-testid="kpi-prompt-tokens"
      />
      <KpiCard
        label="Completion Tokens"
        :value="run?.completionTokens !== null && run?.completionTokens !== undefined ? String(run.completionTokens) : '—'"
        :sub="engineNote ?? 'generated'"
        data-testid="kpi-completion-tokens"
      />
    </div>

    <div class="chart-block">
      <div class="block-title">
        Live Generation Speed
        <span class="decode-info" v-if="decodeTime !== null">decode {{ fmt(decodeTime / 1000, 2, 's') }}</span>
      </div>
      <SpeedChart :series="chartSeries" height="240px" />
    </div>

    <div class="feed-block">
      <div class="block-title">Response Stream</div>
      <pre class="feed" data-testid="feed">{{ liveContent || '—' }}</pre>
    </div>
  </section>
</template>

<style scoped>
.live-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-width: 0;
}
.live-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}
.badge.running {
  color: var(--accent);
  border-color: var(--accent);
}
.badge.done {
  color: var(--ok);
  border-color: var(--ok);
}
.badge.error {
  color: var(--danger);
  border-color: var(--danger);
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.elapsed {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  font-size: 13px;
}
.save {
  margin-left: auto;
  background: var(--bg-inset);
  border: 1px solid var(--ok);
  color: var(--ok);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
}
.save:hover {
  filter: brightness(1.2);
}
.error-banner {
  background: rgba(229, 107, 140, 0.12);
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  font-family: var(--mono);
  word-break: break-all;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.chart-block,
.feed-block {
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
  display: flex;
  justify-content: space-between;
}
.decode-info {
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.feed {
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>