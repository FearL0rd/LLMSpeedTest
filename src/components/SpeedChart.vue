<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { SpeedSample } from '../types';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const props = defineProps<{
  series: Array<{ name: string; samples: SpeedSample[] }>;
  height?: string;
  yName?: string;
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let observer: ResizeObserver | null = null;

function buildOption(): echarts.EChartsCoreOption {
  const totalMs = Math.max(
    1000,
    ...props.series.flatMap((s) => s.samples.map((p) => p.t)),
  );
  return {
    animation: false,
    grid: { left: 52, right: 18, top: 32, bottom: 42 },
    legend: {
      show: props.series.length > 1,
      textStyle: { color: '#9aa4b2', fontSize: 11 },
      top: 0,
    },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)} tok/s` : String(v)),
    },
    xAxis: {
      type: 'value',
      name: 's',
      nameTextStyle: { color: '#9aa4b2' },
      min: 0,
      max: Math.ceil(totalMs / 100) / 10,
      axisLabel: { color: '#9aa4b2', formatter: (v: number) => v.toFixed(1) },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
    },
    yAxis: {
      type: 'value',
      name: props.yName ?? 'tok/s',
      nameTextStyle: { color: '#9aa4b2' },
      axisLabel: { color: '#9aa4b2' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
    },
    dataZoom: props.series.some((s) => s.samples.length > 200)
      ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 6 }]
      : [],
    series: props.series.map((s, i) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: false,
      smooth: false,
      sampling: 'lttb' as const,
      large: true,
      data: s.samples.map((p) => [+(p.t / 1000).toFixed(2), +p.tokensPerSec.toFixed(1)]),
      lineStyle: { width: 1.6, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
    })),
  };
}

const PALETTE = ['#569cff', '#f7b955', '#5dd39e', '#e56b8c', '#b58cff', '#62d9e8'];

function refresh(): void {
  if (!chart) return;
  chart.setOption(buildOption(), { notMerge: true });
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value);
  chart.setOption(buildOption());
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(el.value);
});

watch(
  () => props.series,
  () => refresh(),
);

onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" class="speed-chart" :style="{ height: height ?? '280px' }"></div>
</template>

<style scoped>
.speed-chart {
  width: 100%;
  min-width: 0;
}
</style>