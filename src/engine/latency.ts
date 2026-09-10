/**
 * Baseline latency measurement, llama-benchy style.
 *
 * `generation` mode (default): times 1-token streaming probes and discards
 * the first as a request-shape warmup — approximates pure network + server
 * overhead so `est_ppt = TTFR - latency` isolates prompt processing.
 * `api` mode: times GET /v1/models (network only).
 */
import { MetricsAccumulator } from './metrics';
import { buildRequestUrl } from './url';
import type { StreamConfig } from '../types';

export type LatencyMode = 'generation' | 'api' | 'none';

export function latencyConfig(config: StreamConfig): LatencyMode {
  return config.latencyMode ?? 'generation';
}

export async function measureBaselineLatency(
  config: StreamConfig,
  signal?: AbortSignal,
): Promise<number | null> {
  const mode = latencyConfig(config);
  if (mode === 'none') return null;
  try {
    return mode === 'api' ? await measureApiLatency(config, signal) : await measureGenerationLatency(config, signal);
  } catch {
    return null;
  }
}

async function measureApiLatency(config: StreamConfig, signal?: AbortSignal): Promise<number | null> {
  const url = `${buildRequestUrl(config).replace(/\/chat\/completions$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.apiKey && config.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const resp = await fetch(url, { headers, signal });
    await resp.arrayBuffer();
    samples.push(performance.now() - t0);
  }
  return mean(samples);
}

async function measureGenerationLatency(config: StreamConfig, signal?: AbortSignal): Promise<number | null> {
  const probe: StreamConfig = {
    ...config,
    systemPrompt: '',
    prompt: 'Hi',
    maxTokens: 1,
    minTokens: undefined,
    ignoreEos: undefined,
    includeUsage: true,
  };
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const acc = new MetricsAccumulator();
    acc.start();
    await probeOnce(probe, (c) => acc.ingest(c), signal);
    // First probe warms up the request shape and is discarded.
    const ttfr = i === 0 ? null : acc.finalize().ttfrMs;
    if (ttfr !== null) samples.push(ttfr);
  }
  return samples.length > 0 ? mean(samples) : null;
}

async function probeOnce(
  config: StreamConfig,
  onChunk: (raw: import('../types').RawChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { streamCompletion } = await import('./streaming');
  await streamCompletion(config, onChunk, signal);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
