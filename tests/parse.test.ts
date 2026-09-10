import { describe, expect, it } from 'vitest';
import { parseChunk, parseSseData } from '../src/engine/parse';
import { normalizeEndpoint } from '../src/engine/url';

describe('parseChunk', () => {
  it('parses valid JSON objects', () => {
    const chunk = parseChunk('{"choices":[{"delta":{"content":"hi"}}]}');
    expect(chunk).not.toBeNull();
    expect(chunk?.choices?.[0]?.delta?.content).toBe('hi');
  });

  it('returns null for invalid JSON', () => {
    expect(parseChunk('not json')).toBeNull();
    expect(parseChunk('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseChunk('42')).toBeNull();
    expect(parseChunk('"str"')).toBeNull();
    expect(parseChunk('null')).toBeNull();
  });
});

describe('parseSseData', () => {
  it('extracts payloads from data lines', () => {
    expect(parseSseData('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseData('data:[DONE]')).toBe('[DONE]');
  });

  it('ignores non-data lines and empty payloads', () => {
    expect(parseSseData('event: message')).toBeNull();
    expect(parseSseData(': keep-alive')).toBeNull();
    expect(parseSseData('data:   ')).toBeNull();
  });
});

describe('normalizeEndpoint', () => {
  it('appends /v1/chat/completions to bare hosts', () => {
    expect(normalizeEndpoint('http://localhost:11434')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('appends /chat/completions to /v1 bases', () => {
    expect(normalizeEndpoint('http://localhost:8000/v1')).toBe(
      'http://localhost:8000/v1/chat/completions',
    );
  });

  it('keeps full completions paths and strips trailing slashes', () => {
    expect(normalizeEndpoint('http://localhost:1234/v1/chat/completions/')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });

  it('handles Ollama, vLLM and LM Studio style endpoints', () => {
    expect(normalizeEndpoint('http://localhost:11434/')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(normalizeEndpoint('http://localhost:8000/v1/')).toBe(
      'http://localhost:8000/v1/chat/completions',
    );
    expect(normalizeEndpoint('http://localhost:1234')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });
});