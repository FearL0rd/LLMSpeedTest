import { describe, expect, it } from 'vitest';
import { parseStoredConfig } from '../src/stores/benchmark';

describe('parseStoredConfig (connection settings persistence)', () => {
  it('round-trips the connection fields', () => {
    const saved = JSON.stringify({
      endpoint: 'http://192.168.200.15:8080',
      apiKey: 'sk-test',
      model: 'qwen3-next:latest',
      hardware: 'RTX 3090',
      label: 'aiserver · qwen',
      systemPrompt: 'be terse',
      prompt: 'count to ten',
      temperature: 0.2,
      maxTokens: 512,
      includeUsage: false,
      latencyMode: 'api',
    });
    expect(parseStoredConfig(saved)).toEqual({
      endpoint: 'http://192.168.200.15:8080',
      apiKey: 'sk-test',
      model: 'qwen3-next:latest',
      hardware: 'RTX 3090',
      label: 'aiserver · qwen',
      systemPrompt: 'be terse',
      prompt: 'count to ten',
      temperature: 0.2,
      maxTokens: 512,
      includeUsage: false,
      latencyMode: 'api',
    });
  });

  it('drops unknown keys and coerces wrong types', () => {
    const saved = JSON.stringify({
      endpoint: 'http://ok:1',
      model: 123,
      temperature: 'hot',
      maxTokens: -5,
      latencyMode: 'quantum',
      includeUsage: 'yes',
      unknownField: 'drop me',
    });
    const parsed = parseStoredConfig(saved);
    expect(parsed.endpoint).toBe('http://ok:1');
    expect(parsed.model).toBe('123');
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.maxTokens).toBeUndefined();
    expect(parsed.latencyMode).toBeUndefined();
    expect(parsed.includeUsage).toBe(true);
    expect((parsed as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it('handles null, empty, and malformed payloads', () => {
    expect(parseStoredConfig(null)).toEqual({});
    expect(parseStoredConfig('')).toEqual({});
    expect(parseStoredConfig('not json')).toEqual({});
    expect(parseStoredConfig('42')).toEqual({});
    expect(parseStoredConfig('null')).toEqual({});
  });
});
