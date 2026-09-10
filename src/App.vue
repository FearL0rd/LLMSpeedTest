<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBenchmarkStore } from './stores/benchmark';
import ConfigPanel from './components/ConfigPanel.vue';
import LiveRun from './components/LiveRun.vue';
import ComparisonView from './components/ComparisonView.vue';
import SuitePanel from './components/SuitePanel.vue';
import SuiteResults from './components/SuiteResults.vue';

const store = useBenchmarkStore();
const { compareIds } = storeToRefs(store);

const tab = ref<'run' | 'suite' | 'compare'>('run');
const compareCount = computed(() => compareIds.value.length);
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="bolt">⚡</span>
        <h1>LLM Speedtest</h1>
      </div>
      <nav class="tabs">
        <button
          :class="{ active: tab === 'run' }"
          data-testid="tab-run"
          @click="tab = 'run'"
        >
          Benchmark
        </button>
        <button
          :class="{ active: tab === 'suite' }"
          data-testid="tab-suite"
          @click="tab = 'suite'"
        >
          Suite
        </button>
        <button
          :class="{ active: tab === 'compare' }"
          data-testid="tab-compare"
          @click="tab = 'compare'"
        >
          Compare <span v-if="compareCount > 0" class="count">{{ compareCount }}</span>
        </button>
      </nav>
    </header>

    <main v-show="tab === 'run'" class="run-layout">
      <ConfigPanel />
      <LiveRun />
    </main>

    <main v-show="tab === 'suite'" class="suite-layout">
      <SuitePanel />
      <SuiteResults />
    </main>

    <main v-show="tab === 'compare'" class="compare-layout">
      <ComparisonView />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand h1 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: 0.02em;
}
.bolt {
  font-size: 18px;
}
.tabs {
  display: flex;
  gap: 6px;
}
.tabs button {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  border-radius: 8px;
  padding: 7px 16px;
  font-size: 13px;
  cursor: pointer;
}
.tabs button:hover {
  color: var(--text);
}
.tabs button.active {
  background: var(--bg-inset);
  border-color: var(--border);
  color: var(--text);
}
.tabs .count {
  display: inline-block;
  min-width: 18px;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  text-align: center;
}
.run-layout,
.suite-layout,
.compare-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 16px;
  padding: 16px;
}
.run-layout {
  grid-template-columns: 340px 1fr;
}
.suite-layout {
  grid-template-columns: 340px 1fr;
}
.compare-layout {
  grid-template-columns: 1fr;
}
@media (max-width: 860px) {
  .run-layout,
  .suite-layout {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
}
</style>