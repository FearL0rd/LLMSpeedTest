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

/**
 * Warm up the GPU cards before measuring: a short burst of discarded
 * generations (GPUs idle at low clocks; the first measured requests would
 * otherwise run unboosted). Unique prompts so the server's prefix cache
 * can't skip the work.
 */
export async function warmUpCards(config: StreamConfig, signal?: AbortSignal): Promise<void> {
  const t0 = performance.now();
  for (let i = 0; i < 3 && performance.now() - t0 < 3000 && !signal?.aborted; i++) {
    const probe: StreamConfig = {
      ...config,
      prompt: `Warm-up request ${i} ${Math.random().toString(36).slice(2, 8)}. Count slowly from one to ten.`,
      maxTokens: 64,
      minTokens: undefined,
      ignoreEos: undefined,
    };
    await probeOnce(probe, () => {}, signal).catch(() => undefined);
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
