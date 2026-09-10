<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useSuiteStore } from '../stores/suite';

const store = useSuiteStore();
const { suiteConfig, ppText, tgText, depthText, concText, running, progress, progressPct, error } =
  storeToRefs(store);
</script>

<template>
  <section class="panel suite-panel" data-testid="suite-panel">
    <h2>Test Matrix</h2>

    <label class="field">
      <span>Prompt Processing Targets (tokens, comma-separated)</span>
      <input v-model="ppText" type="text" placeholder="512, 2048" spellcheck="false" data-testid="suite-pp" />
    </label>

    <label class="field">
      <span>Generation Lengths (tokens)</span>
      <input v-model="tgText" type="text" placeholder="64, 128" spellcheck="false" data-testid="suite-tg" />
    </label>

    <label class="field">
      <span>Context Depths (tokens; 0 = no padding)</span>
      <input v-model="depthText" type="text" placeholder="0, 4096, 16384" spellcheck="false" data-testid="suite-depth" />
    </label>

    <label class="field">
      <span>Concurrency Levels</span>
      <input v-model="concText" type="text" placeholder="1, 2, 4" spellcheck="false" data-testid="suite-conc" />
    </label>

    <div class="field-row">
      <label class="field">
        <span>Measured Runs</span>
        <input v-model.number="suiteConfig.runs" type="number" min="1" max="20" data-testid="suite-runs" />
      </label>
      <label class="field">
        <span>Warmup Runs (discarded)</span>
        <input v-model.number="suiteConfig.warmup" type="number" min="0" max="10" data-testid="suite-warmup" />
      </label>
    </div>

    <h2>Options</h2>
    <label class="check">
      <input v-model="suiteConfig.exactTg" type="checkbox" data-testid="suite-exact-tg" />
      <span>Exact generation length (min_tokens + ignore_eos)</span>
    </label>
    <label class="check">
      <input v-model="suiteConfig.prefixCaching" type="checkbox" data-testid="suite-caching" />
      <span>Measure prefix caching (context load vs cached prefill)</span>
    </label>
    <label class="check">
      <input v-model="suiteConfig.coherence" type="checkbox" data-testid="suite-coherence" />
      <span>Coherence check (model answers 2+2)</span>
    </label>

    <div class="actions">
      <button v-if="!running" class="primary" data-testid="suite-run-btn" @click="store.run()">
        ▶ Run Suite
      </button>
      <button v-else class="danger" data-testid="suite-cancel-btn" @click="store.cancel()">
        ■ Cancel
      </button>
    </div>

    <div v-if="error" class="error-banner" data-testid="suite-error">{{ error }}</div>

    <div v-if="running || progressPct > 0" class="progress-block">
      <div class="progress-label" data-testid="suite-progress-label">
        {{ progress.label || 'Idle' }} ({{ progress.done }}/{{ progress.total }})
      </div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.suite-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}
h2 {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 8px 0 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.field > span {
  font-size: 12px;
  color: var(--muted);
}
.field > span em {
  font-style: normal;
  opacity: 0.7;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
input,
select {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
input:focus,
select:focus {
  outline: none;
  border-color: var(--accent);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
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
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
  flex: 1;
}
button.danger {
  background: transparent;
  border-color: var(--danger);
  color: var(--danger);
  flex: 1;
}
.error-banner {
  background: rgba(229, 107, 140, 0.12);
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  word-break: break-all;
}
.progress-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress-label {
  font-size: 12px;
  color: var(--muted);
}
.progress-track {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-inset);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
</style>