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

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const PALETTE = ['#569cff', '#f7b955', '#5dd39e', '#e56b8c', '#b58cff', '#62d9e8'];

const props = defineProps<{
  series: Array<{ name: string; points: Array<[number, number]> }>;
  xName?: string;
  yName?: string;
  height?: string;
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let observer: ResizeObserver | null = null;

function buildOption(): echarts.EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 56, right: 18, top: 32, bottom: 36 },
    legend: {
      show: props.series.length > 1,
      textStyle: { color: '#9aa4b2', fontSize: 11 },
      top: 0,
    },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'value',
      name: props.xName ?? '',
      nameTextStyle: { color: '#9aa4b2' },
      axisLabel: { color: '#9aa4b2' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
    },
    yAxis: {
      type: 'value',
      name: props.yName ?? '',
      nameTextStyle: { color: '#9aa4b2' },
      axisLabel: { color: '#9aa4b2' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
    },
    series: props.series.map((s, i) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: true,
      symbolSize: 6,
      data: s.points,
      lineStyle: { width: 1.8, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
    })),
  };
}

function refresh(): void {
  chart?.setOption(buildOption(), { notMerge: true });
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
  <div ref="el" class="line-chart" :style="{ height: height ?? '260px' }"></div>
</template>

<style scoped>
.line-chart {
  width: 100%;
  min-width: 0;
}
</style>