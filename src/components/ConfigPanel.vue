<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useBenchmarkStore } from '../stores/benchmark';
import { summarizeEngine, summarizeSystem } from '../engine/probe';

const store = useBenchmarkStore();
const { config, isRunning, probing, probeError, probeInfo, sameHost, systemInfo, modelSuggestions } =
  storeToRefs(store);

const engineSummary = computed(() => summarizeEngine(probeInfo.value?.engine ?? null));
const hardwareSummary = computed(() =>
  systemInfo.value ? summarizeSystem(systemInfo.value) : '',
);
</script>

<template>
  <section class="panel config-panel">
    <h2>Connection</h2>

    <label class="field">
      <span>API Endpoint</span>
      <div class="endpoint-row">
        <input
          v-model="config.endpoint"
          type="text"
          placeholder="http://localhost:11434"
          spellcheck="false"
          data-testid="endpoint"
        />
        <button
          class="detect"
          :disabled="!config.endpoint || probing"
          title="Identify engine, models and hardware"
          data-testid="detect-btn"
          @click="store.detectEndpoint()"
        >
          {{ probing ? '…' : 'Detect' }}
        </button>
      </div>
    </label>

    <div
      v-if="probeInfo || probeError"
      class="probe-info"
      :class="{ error: probeError }"
      data-testid="probe-info"
    >
      <template v-if="probeError">{{ probeError }}</template>
      <template v-else-if="probeInfo">
        <span class="engine" :class="{ found: probeInfo.engine.engine }">{{ engineSummary }}</span>
        <span v-if="sameHost && hardwareSummary" class="same-host" data-testid="local-hw">
          this machine: {{ hardwareSummary }}
        </span>
        <span v-else-if="!sameHost" class="hint" data-testid="remote-hint">
          Remote server — hardware is not exposed by any LLM API. Enter it in the Hardware field
          below.
        </span>
      </template>
    </div>

    <label class="field">
      <span>API Key <em>(optional)</em></span>
      <input
        v-model="config.apiKey"
        type="password"
        placeholder="sk-..."
        spellcheck="false"
        data-testid="api-key"
      />
    </label>

    <label class="field">
      <span>Model</span>
      <input
        v-model="config.model"
        type="text"
        placeholder="llama3.2:3b"
        spellcheck="false"
        list="model-suggestions"
        data-testid="model"
      />
      <datalist id="model-suggestions">
        <option v-for="m in modelSuggestions" :key="m" :value="m" />
      </datalist>
    </label>

    <label class="field">
      <span>Hardware <em>(auto-detected for localhost, manual for remote)</em></span>
      <input
        v-model="config.hardware"
        type="text"
        placeholder="RTX 4090 · 24 GB — or press Detect"
        spellcheck="false"
        data-testid="hardware"
      />
    </label>

    <label class="field">
      <span>Profile Label <em>(for comparisons)</em></span>
      <input
        v-model="config.label"
        type="text"
        placeholder="Ollama · llama3.2 · Q4_K_M"
        spellcheck="false"
        data-testid="label"
      />
    </label>

    <h2>Prompt</h2>

    <label class="field">
      <span>System Prompt</span>
      <textarea
        v-model="config.systemPrompt"
        rows="3"
        placeholder="You are a helpful assistant."
        spellcheck="false"
        data-testid="system-prompt"
      ></textarea>
    </label>

    <label class="field">
      <span>User Prompt</span>
      <textarea
        v-model="config.prompt"
        rows="4"
        spellcheck="false"
        data-testid="prompt"
      ></textarea>
    </label>

    <div class="field-row">
      <label class="field">
        <span>Temperature</span>
        <input
          v-model.number="config.temperature"
          type="number"
          min="0"
          max="2"
          step="0.1"
          data-testid="temperature"
        />
      </label>
      <label class="field">
        <span>Max Tokens <em>(optional)</em></span>
        <input
          v-model.number="config.maxTokens"
          type="number"
          min="1"
          step="1"
          placeholder="auto"
          data-testid="max-tokens"
        />
      </label>
    </div>

    <label class="check">
      <input v-model="config.includeUsage" type="checkbox" data-testid="include-usage" />
      <span>Request usage counts (stream_options.include_usage)</span>
    </label>

    <label class="field">
      <span>Latency Baseline <em>(for est_ppt / prompt-processing speed)</em></span>
      <select v-model="config.latencyMode" data-testid="latency-mode">
        <option value="generation">1-token generation probes (recommended)</option>
        <option value="api">/models request (network only)</option>
        <option value="none">Off</option>
      </select>
    </label>

    <div class="actions">
      <button
        v-if="!isRunning"
        class="primary"
        :disabled="!config.endpoint || !config.model || !config.prompt"
        data-testid="run-btn"
        @click="store.runBenchmark()"
      >
        ▶ Run Benchmark
      </button>
      <button v-else class="danger" data-testid="cancel-btn" @click="store.cancelRun()">
        ■ Cancel
      </button>
    </div>
  </section>
</template>

<style scoped>
.config-panel {
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
.endpoint-row {
  display: flex;
  gap: 8px;
}
.endpoint-row input {
  flex: 1;
  min-width: 0;
}
.detect {
  border: 1px solid var(--border);
  background: var(--bg-inset);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.detect:hover:not(:disabled) {
  border-color: var(--accent);
}
.detect:disabled {
  opacity: 0.5;
  cursor: wait;
}
.probe-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--muted);
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  word-break: break-word;
}
.probe-info.error {
  color: var(--danger);
  border-color: var(--danger);
}
.probe-info .engine.found {
  color: var(--ok);
}
.probe-info .same-host {
  opacity: 0.8;
}
.probe-info .hint {
  opacity: 0.85;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
input:not([type='checkbox']),
textarea {
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
input[type='checkbox'] {
  width: auto;
  accent-color: var(--accent);
}
input:not([type='checkbox']):focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
}
textarea {
  resize: vertical;
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
  flex: 1;
}
button.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
button.danger {
  background: transparent;
  border-color: var(--danger);
  color: var(--danger);
  flex: 1;
}
</style>