import type { RawChunk } from '../types';

/** Safely parse a raw SSE data payload into a normalized chunk. */
export function parseChunk(json: string): RawChunk | null {
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object') {
      return value as RawChunk;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract a data payload from an SSE line, or null if the line carries none. */
export function parseSseData(line: string): string | null {
  const rest = line.startsWith('data:') ? line.slice(5).trim() : null;
  return rest && rest.length > 0 ? rest : null;
}