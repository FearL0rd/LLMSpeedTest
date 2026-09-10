import { describe, expect, it } from 'vitest';
import {
  deriveBaseUrl,
  detectEngine,
  formatBytes,
  isSameHost,
  quantFromFilename,
  summarizeEngine,
  summarizeSystem,
} from '../src/engine/probe';
import type { ProbeResult } from '../src/engine/probe';
import type { SystemInfo } from '../src/types';

const probe = (path: string, body: unknown | string, status = 200): ProbeResult => ({
  path,
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const unreachable = (path: string): ProbeResult => ({ path, status: 0, body: null });

describe('detectEngine', () => {
  it('identifies Ollama with version, model list and VRAM footprint', () => {
    const info = detectEngine([
      probe('/api/version', { version: '0.5.7' }),
      probe('/api/ps', {
        models: [{ name: 'llama3.2:Q4_K_M', size_vram: 3_963_612_866 }],
      }),
      probe('/v1/models', { data: [{ id: 'llama3.2:latest' }, { id: 'qwen2.5:7b' }] }),
      probe('/version', { version: '9.9.9' }), // must NOT win over /api/version
      unreachable('/metrics'),
    ]);

    expect(info.engine).toBe('Ollama');
    expect(info.version).toBe('0.5.7');
    expect(info.models).toEqual(['llama3.2:latest', 'qwen2.5:7b']);
    expect(info.vram).toEqual([{ model: 'llama3.2:Q4_K_M', bytes: 3_963_612_866 }]);
  });

  it('identifies vLLM from /version', () => {
    const info = detectEngine([
      unreachable('/api/version'),
      probe('/version', { version: '0.6.6' }),
      probe('/v1/models', { data: [{ id: 'meta-llama/Llama-3.1-8B' }] }),
    ]);
    expect(info.engine).toBe('vLLM');
    expect(info.version).toBe('0.6.6');
    expect(info.models).toEqual(['meta-llama/Llama-3.1-8B']);
  });

  it('falls back to vLLM detection via Prometheus metric names', () => {
    const info = detectEngine([
      unreachable('/api/version'),
      unreachable('/version'),
      probe('/metrics', '# HELP vllm:gpu_cache_usage_perc gpu usage\nvllm:gpu_cache_usage_perc 0.42'),
    ]);
    expect(info.engine).toBe('vLLM');
  });

  it('identifies llama.cpp, SGLang and LM Studio', () => {
    expect(detectEngine([probe('/props', { total_slots: 1 })]).engine).toBe('llama.cpp');
    expect(detectEngine([probe('/get_server_info', { mem_get_info: {} })]).engine).toBe('SGLang');
    const lm = detectEngine([
      probe('/api/v0/models', {
        data: [
          { id: 'qwen2.5', state: 'loaded', quantization: 'Q4_K_M' },
          { id: 'llama3', state: 'not-loaded', quantization: 'Q8_0' },
          { id: 'phi3', state: 'loaded', quantization: 'Q4_K_M' },
        ],
      }),
    ]);
    expect(lm.engine).toBe('LM Studio');
    expect(lm.quantizations).toEqual(['Q4_K_M']);
  });

  it('extracts model path and quantization from llama.cpp /props', () => {
    const info = detectEngine([
      probe('/props', {
        model_path: '/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        total_slots: 1,
        default_generation_settings: { model: 'qwen2.5' },
      }),
    ]);
    expect(info.engine).toBe('llama.cpp');
    expect(info.modelPath).toBe('/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf');
    expect(info.quantizations).toEqual(['Q4_K_M']);
    expect(summarizeEngine(info)).toContain('Qwen2.5-7B-Instruct-Q4_K_M.gguf');
  });

  it('does not claim llama.cpp when /props lacks its signature keys', () => {
    const info = detectEngine([probe('/props', { hello: 'world' })]);
    expect(info.engine).toBeNull();
  });

  it('falls back to llama.cpp detection via Prometheus metric names', () => {
    const info = detectEngine([
      unreachable('/props'),
      probe('/metrics', '# HELP llamacpp:prompt_tokens_seconds\nllamacpp:prompt_tokens_seconds 0.1'),
    ]);
    expect(info.engine).toBe('llama.cpp');
  });

  it('infers quantization from common GGUF filename styles', () => {
    expect(quantFromFilename('Meta-Llama-3.1-8B-Instruct.IQ4_XS.gguf')).toBe('IQ4_XS');
    expect(quantFromFilename('model-q8_0.gguf')).toBe('Q8_0');
    expect(quantFromFilename('model.f16.gguf')).toBe('F16');
    expect(quantFromFilename('no-quant-here.gguf')).toBeNull();
    expect(quantFromFilename(null)).toBeNull();
  });

  it('returns a null engine when nothing matches', () => {
    const info = detectEngine([unreachable('/api/version'), probe('/metrics', 'random text'), probe('/v1/models', { data: [] })]);
    expect(info.engine).toBeNull();
    expect(info.version).toBeNull();
    expect(info.models).toEqual([]);
  });

  it('ignores non-200 probe results', () => {
    const info = detectEngine([probe('/api/version', { version: 'x' }, 403)]);
    expect(info.engine).toBeNull();
  });
});

describe('deriveBaseUrl / isSameHost', () => {
  it('strips OpenAI path suffixes to the origin', () => {
    expect(deriveBaseUrl('http://box:11434')).toBe('http://box:11434');
    expect(deriveBaseUrl('http://box:11434/')).toBe('http://box:11434');
    expect(deriveBaseUrl('http://box:8000/v1')).toBe('http://box:8000');
    expect(deriveBaseUrl('http://box:8000/v1/chat/completions')).toBe('http://box:8000');
    expect(deriveBaseUrl('http://box:1234/v1/chat/completions/')).toBe('http://box:1234');
  });

  it('treats localhost variants as the same host and LAN IPs as remote', () => {
    expect(isSameHost('http://localhost:11434')).toBe(true);
    expect(isSameHost('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isSameHost('http://LOCALHOST:8080')).toBe(true);
    expect(isSameHost('http://192.168.1.50:11434')).toBe(false);
    expect(isSameHost('http://llm-box.local:11434')).toBe(false);
  });
});

describe('summarizeSystem', () => {
  it('joins available hardware facts', () => {
    const info: SystemInfo = {
      os: 'Windows 11 Pro',
      cpu: 'AMD Ryzen 9 7900X',
      coresPhysical: 12,
      coresLogical: 24,
      totalMemoryBytes: 68 * 1024 ** 3,
      gpus: ['NVIDIA GeForce RTX 4090'],
    };
    const s = summarizeSystem(info);
    expect(s).toContain('AMD Ryzen 9 7900X');
    expect(s).toContain('12C/24T');
    expect(s).toContain('68 GB RAM');
    expect(s).toContain('NVIDIA GeForce RTX 4090');
    expect(s).toContain('Windows 11 Pro');
  });

  it('is empty without info', () => {
    expect(summarizeSystem(null)).toBe('');
  });
});

describe('summarizeEngine', () => {
  it('prefers VRAM info, then quantizations, then model count', () => {
    expect(
      summarizeEngine({
        engine: 'Ollama',
        version: '0.5.7',
        models: ['a'],
        vram: [{ model: 'llama3.2:Q4_K_M', bytes: 3_963_612_866 }],
        quantizations: [],
      }),
    ).toContain('3.7 GB VRAM');

    expect(
      summarizeEngine({
        engine: 'LM Studio',
        version: null,
        models: [],
        vram: [],
        quantizations: ['Q4_K_M'],
      }),
    ).toContain('Q4_K_M');

    expect(
      summarizeEngine({ engine: 'vLLM', version: '0.6.6', models: ['a', 'b'], vram: [], quantizations: [] }),
    ).toContain('2 models');

    expect(summarizeEngine({ engine: null, version: null, models: [], vram: [], quantizations: [] })).toContain(
      'No engine identified',
    );
  });
});

describe('formatBytes', () => {
  it('formats human-readable sizes', () => {
    expect(formatBytes(3_963_612_866)).toBe('3.7 GB');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(0)).toBe('—');
  });
});