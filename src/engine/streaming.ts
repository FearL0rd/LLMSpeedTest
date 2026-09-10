import { invoke, Channel } from '@tauri-apps/api/core';
import type { RawChunk, StreamConfig } from '../types';
import { parseChunk, parseSseData } from './parse';
import { buildRequestUrl, normalizeEndpoint } from './url';

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export { buildRequestUrl, normalizeEndpoint };

/**
 * Stream a chat completion, invoking onChunk for every parsed chunk.
 * Uses the Rust reqwest transport inside Tauri (CORS-free) and plain fetch
 * with SSE parsing in the browser (dev mode / tests).
 */
export async function streamCompletion(
  config: StreamConfig,
  onChunk: (chunk: RawChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isTauri()) {
    await streamViaTauri(config, onChunk);
  } else {
    await streamViaFetch(config, onChunk, signal);
  }
}

async function streamViaTauri(
  config: StreamConfig,
  onChunk: (chunk: RawChunk) => void,
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (payload) => {
    const chunk = parseChunk(payload);
    if (chunk) onChunk(chunk);
  };
  await invoke('stream_completion', {
    config: {
      endpoint: config.endpoint,
      apiKey: config.apiKey || null,
      model: config.model,
      systemPrompt: config.systemPrompt || null,
      prompt: config.prompt,
      temperature: config.temperature ?? null,
      maxTokens: config.maxTokens ?? null,
      minTokens: config.minTokens ?? null,
      ignoreEos: config.ignoreEos ?? null,
      includeUsage: config.includeUsage ?? true,
    },
    onChunk: channel,
  });
}

async function streamViaFetch(
  config: StreamConfig,
  onChunk: (chunk: RawChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const messages: Array<{ role: string; content: string }> = [];
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    messages.push({ role: 'system', content: config.systemPrompt });
  }
  messages.push({ role: 'user', content: config.prompt });

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: config.includeUsage ?? true },
  };
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;
  if (config.minTokens !== undefined) body.min_tokens = config.minTokens;
  if (config.ignoreEos !== undefined) body.ignore_eos = config.ignoreEos;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.apiKey && config.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const response = await fetch(buildRequestUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.body) {
    throw new Error('Response has no body to stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processLine = (line: string): boolean => {
    const payload = parseSseData(line.trim());
    if (payload === null) return false;
    if (payload === '[DONE]') return true;
    const chunk = parseChunk(payload);
    if (chunk) onChunk(chunk);
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (processLine(line)) return;
    }
  }
  if (buffer.trim().length > 0) processLine(buffer);
}