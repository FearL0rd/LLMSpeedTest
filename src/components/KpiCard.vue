<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}>();
</script>

<template>
  <div class="kpi-card" :class="{ highlight }">
    <div class="kpi-label">{{ label }}</div>
    <div class="kpi-value">{{ value }}</div>
    <div v-if="sub" class="kpi-sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.kpi-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  min-width: 0;
}
.kpi-card.highlight {
  border-color: var(--accent);
}
.kpi-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.kpi-value {
  font-size: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kpi-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>