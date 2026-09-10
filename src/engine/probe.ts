import { invoke } from '@tauri-apps/api/core';
import type { SystemInfo } from '../types';
import { isTauri } from './streaming';

/** Raw result of one HTTP probe against a well-known engine path. */
export interface ProbeResult {
  path: string;
  /** HTTP status, or 0 when unreachable/timed out. */
  status: number;
  body: string | null;
}

export interface OllamaVram {
  model: string;
  bytes: number;
}

/** What we could identify about the server behind an endpoint. */
export interface EngineInfo {
  engine: string | null;
  version: string | null;
  /** Model IDs from the standard /v1/models listing. */
  models: string[];
  /** Ollama-only: loaded models and their VRAM footprint. */
  vram: OllamaVram[];
  /** Quantization hints (LM Studio API, or llama.cpp model filename). */
  quantizations: string[];
  /** llama.cpp-only: server-side model file path from /props. */
  modelPath: string | null;
}

/**
 * Probe well-known engine paths served alongside the OpenAI API.
 * Uses the Rust transport inside Tauri (CORS-free), direct fetch in the browser.
 */
export async function probeEndpoint(
  endpoint: string,
  apiKey?: string,
): Promise<ProbeResult[]> {
  if (isTauri()) {
    return invoke<ProbeResult[]>('probe_endpoint', {
      endpoint,
      apiKey: apiKey || null,
    });
  }
  const base = deriveBaseUrl(endpoint);
  const paths = [
    '/api/version',
    '/api/ps',
    '/version',
    '/props',
    '/get_server_info',
    '/api/v0/models',
    '/v1/models',
    '/metrics',
  ];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey && apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return Promise.all(
    paths.map(async (path) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const resp = await fetch(`${base}${path}`, {
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = resp.ok ? (await resp.text()).slice(0, 40_000) : null;
        return { path, status: resp.status, body };
      } catch {
        return { path, status: 0, body: null };
      }
    }),
  );
}

/** Hardware of this machine; null outside the Tauri desktop shell. */
export async function getSystemInfo(): Promise<SystemInfo | null> {
  if (!isTauri()) return null;
  return invoke<SystemInfo>('get_system_info');
}

/**
 * True when the endpoint points at this machine (same-host endpoints can be
 * auto-enriched with local hardware info; remote ones cannot).
 */
export function isSameHost(endpoint: string): boolean {
  try {
    const { hostname } = new URL(deriveBaseUrl(endpoint));
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Strip OpenAI path suffixes down to the server origin. Mirrors the Rust helper. */
export function deriveBaseUrl(endpoint: string): string {
  let base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length);
  return base.replace(/\/+$/, '');
}

function parseJson(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ok(p: ProbeResult | undefined): p is ProbeResult & { body: string } {
  return p !== undefined && p.status === 200 && p.body !== null && p.body.length > 0;
}

function findOk(
  probes: ProbeResult[],
  path: string,
): (ProbeResult & { body: string }) | undefined {
  return probes.find((p): p is ProbeResult & { body: string } => p.path === path && ok(p));
}

/** /props exists on many llama.cpp derivatives; require its signature keys. */
function looksLikeLlamaCppProps(body: string): boolean {
  return /"(default_generation_settings|total_slots|model_path|model_meta|modalities)"/.test(body);
}

/** GGUF filenames usually carry the quantization, e.g. Model-Q4_K_M.gguf. */
export function quantFromFilename(path: string | null): string | null {
  if (!path) return null;
  const match = path.match(/(?:^|[-_. ])(IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+|Q\d+|F16|BF16|F32)(?=\.|$|[-_. ])/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Identify the engine from raw probe results. Order matters: engines that
 * also serve generic endpoints (e.g. Ollama serving /v1/models) must be
 * matched on their proprietary paths first.
 */
export function detectEngine(probes: ProbeResult[]): EngineInfo {
  const info: EngineInfo = {
    engine: null,
    version: null,
    models: [],
    vram: [],
    quantizations: [],
    modelPath: null,
  };

  const ollama = findOk(probes, '/api/version');
  const vllm = findOk(probes, '/version');
  const sglang = findOk(probes, '/get_server_info');
  const llamaCpp = findOk(probes, '/props');
  const lmStudio = findOk(probes, '/api/v0/models');

  if (ollama) {
    info.engine = 'Ollama';
    info.version = (parseJson(ollama.body)?.version as string | undefined) ?? null;
  } else if (vllm) {
    info.engine = 'vLLM';
    info.version = (parseJson(vllm.body)?.version as string | undefined) ?? null;
  } else if (sglang) {
    info.engine = 'SGLang';
    const json = parseJson(sglang.body);
    info.version = (json?.version as string | undefined) ?? null;
  } else if (llamaCpp && looksLikeLlamaCppProps(llamaCpp.body)) {
    info.engine = 'llama.cpp';
    const json = parseJson(llamaCpp.body) ?? {};
    // llama.cpp serves the GGUF path here; the filename usually names the
    // model and its quantization, which is what benchmarks compare.
    const generation =
      (json.default_generation_settings as Record<string, unknown> | undefined) ?? {};
    info.modelPath =
      (json.model_path as string | undefined) ??
      (generation.model as string | undefined) ??
      (json.model as string | undefined) ??
      null;
    const build = json.build_info ?? json.build;
    if (typeof build === 'string' && build.length > 0) info.version = build;
    const quant = quantFromFilename(info.modelPath);
    if (quant) info.quantizations = [quant];
  } else if (lmStudio) {
    info.engine = 'LM Studio';
  } else {
    // Prometheus-style fallbacks: metric names are engine-prefixed.
    const metrics = findOk(probes, '/metrics');
    if (metrics) {
      if (/(^|\n)vllm:/m.test(metrics.body)) {
        info.engine = 'vLLM';
      } else if (/(^|\n)(llamacpp|llama_):/m.test(metrics.body)) {
        info.engine = 'llama.cpp';
      }
    }
  }

  const modelsList = findOk(probes, '/v1/models');
  if (modelsList) {
    const json = parseJson(modelsList.body);
    if (Array.isArray(json?.data)) {
      info.models = (json.data as Array<Record<string, unknown>>)
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter((id) => id.length > 0);
    }
  }

  const ps = findOk(probes, '/api/ps');
  if (ps) {
    const json = parseJson(ps.body);
    if (Array.isArray(json?.models)) {
      info.vram = (json.models as Array<Record<string, unknown>>)
        .map((m) => ({
          model: typeof m?.name === 'string' ? m.name : '',
          bytes: typeof m?.size_vram === 'number' ? m.size_vram : 0,
        }))
        .filter((m) => m.model.length > 0 && m.bytes > 0);
    }
  }

  if (lmStudio) {
    const json = parseJson(lmStudio.body);
    if (Array.isArray(json?.data)) {
      const quants = (json.data as Array<Record<string, unknown>>)
        .filter((m) => m?.state === 'loaded' && typeof m?.quantization === 'string')
        .map((m) => m.quantization as string);
      info.quantizations = [...new Set(quants)];
    }
  }

  return info;
}

/** Compact one-line hardware summary for the auto-filled label. */
export function summarizeSystem(info: SystemInfo | null): string {
  if (!info) return '';
  const parts: string[] = [];
  if (info.cpu) parts.push(info.cpu);
  if (info.coresPhysical !== null) {
    parts.push(`${info.coresPhysical}C/${info.coresLogical}T`);
  }
  parts.push(`${(info.totalMemoryBytes / 1024 ** 3).toFixed(0)} GB RAM`);
  if (info.gpus.length > 0) parts.push(info.gpus.join(' + '));
  const disk = primaryDisk(info);
  if (disk) {
    const free = disk.availableBytes > 0 ? ` (${formatBytes(disk.availableBytes)} free)` : '';
    parts.push(`${formatBytes(disk.totalBytes)} ${disk.kind}${free}`);
  }
  if (info.os) parts.push(info.os);
  return parts.join(' · ');
}

/** The disk to advertise: largest SSD if present, else the largest disk. */
export function primaryDisk(info: SystemInfo): SystemInfo['disks'][number] | null {
  if (info.disks.length === 0) return null;
  const ssds = info.disks.filter((d) => d.kind === 'SSD');
  const pool = ssds.length > 0 ? ssds : info.disks;
  return pool.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a));
}

/** Human-readable byte size, e.g. 3.9 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp >= 3 ? 1 : 0)} ${units[exp]}`;
}

/** One-line engine description for the UI badge line. */
export function summarizeEngine(engine: EngineInfo | null): string {
  if (!engine || !engine.engine) return 'No engine identified';
  const parts = [engine.engine];
  if (engine.version) parts.push(`v${engine.version.replace(/^v/, '')}`);
  let extra = '';
  if (engine.vram.length > 0) {
    extra = engine.vram
      .map((v) => `${v.model} (${formatBytes(v.bytes)} VRAM)`)
      .join(', ');
  } else if (engine.quantizations.length > 0) {
    const model = engine.modelPath ? ` · ${baseName(engine.modelPath)}` : '';
    extra = `${engine.quantizations.join(', ')}${model}`;
  } else if (engine.modelPath) {
    extra = baseName(engine.modelPath);
  } else if (engine.models.length > 0) {
    extra = `${engine.models.length} model${engine.models.length === 1 ? '' : 's'} available`;
  }
  return extra ? `${parts.join(' ')} — ${extra}` : parts.join(' ');
}

function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}