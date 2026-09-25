/**
 * LLM-as-judge scoring for scenario answers. The judge prompt asks for a
 * strict JSON object of per-dimension scores (0-100); parsing is tolerant of
 * code fences and prose surrounding the JSON.
 */
import type { ScenarioDef } from './scenarios';

export function buildJudgePrompt(def: ScenarioDef, answer: string): {
  systemPrompt: string;
  prompt: string;
} {
  const rubric = def.dimensions
    .map((d) => `- ${d.key} (weight ${d.weight}%): ${d.name} — ${d.criteria}`)
    .join('\n');
  return {
    systemPrompt:
      'You are a strict, reproducible benchmark evaluator. You score answers ' +
      'against a rubric and respond with JSON only. No prose, no markdown, no ' +
      'explanations.',
    prompt:
      `Scenario: ${def.name}\n` +
      `Answer to evaluate:\n"""\n${answer}\n"""\n\n` +
      `Rubric (score each dimension 0-100):\n${rubric}\n\n` +
      'Do not explain. Do not restate the task. Do not describe your reasoning. /no_think\n' +
      'Respond with exactly this shape, nothing else:\n' +
      '{"scores": {' + def.dimensions.map((d) => `"${d.key}": 0`).join(', ') + '}}',
  };
}

/** Extract a `{...}` JSON object from judge output (handles code fences and prose). */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) return fenced[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

/**
 * All balanced `{...}` candidates (at most one nesting level), the ones
 * containing a "scores" key first. Covers judges that wrap the JSON in prose
 * or emit braces inside their explanation.
 */
function candidateJsonObjects(text: string): string[] {
  const out: string[] = [];
  const re = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  out.sort((a, b) => Number(b.includes('"scores"')) - Number(a.includes('"scores"')));
  return out;
}

/**
 * Try one JSON candidate: accept the object itself or its `scores` member,
 * tolerate key variants (case, underscores, spaces), clamp to 0-100.
 */
function tryParseScores(
  jsonText: string,
  def: ScenarioDef,
): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const scoresKey = Object.keys(record).find((k) => k.toLowerCase() === 'scores');
  const raw = scoresKey ? record[scoresKey] : record;
  if (typeof raw !== 'object' || raw === null) return null;
  // Judge models write "Coherence", "tool_selection", "Tool Selection"… normalize.
  const lut = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    lut.set(k.toLowerCase().replace(/[\s_-]+/g, ''), v);
  }
  const scores: Record<string, number> = {};
  for (const d of def.dimensions) {
    const value = lut.get(d.key.toLowerCase());
    const num = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (typeof num !== 'number' || !Number.isFinite(num)) return null;
    scores[d.key] = Math.max(0, Math.min(100, Math.round(num)));
  }
  return scores;
}

/**
 * Fallback for judges that ignore the JSON instruction and score in prose
 * (e.g. "- correctness: 85", "tool_selection: 90/100"). Matches every
 * dimension key followed by `:`/`=` and a 0-100 number; rubric echoes like
 * "correctness (40%)" don't match (no colon directly after the key, and
 * weight numbers are followed by '%'). Returns null unless ALL dimensions
 * are found.
 */
function parsePlainTextScores(
  judgeOutput: string,
  def: ScenarioDef,
): Record<string, number> | null {
  const scores: Record<string, number> = {};
  for (const d of def.dimensions) {
    // Allow separator variants between camelCase words: tool_selection, "tool selection".
    const keyPattern = d.key.replace(/[A-Z]/g, (m) => `[\\s_-]*${m.toLowerCase()}`);
    const re = new RegExp(`${keyPattern}\\s*[:=]\\s*(\\d{1,3})(?!\\s*%)`, 'i');
    const match = judgeOutput.match(re);
    if (!match) return null;
    scores[d.key] = Math.max(0, Math.min(100, Number.parseInt(match[1], 10)));
  }
  return scores;
}

/**
 * Parse judge output into validated per-dimension scores (integers clamped
 * 0-100). Tries JSON first (fenced, embedded, key variants), then plain-text
 * "key: number" scores. Returns null when unparseable or incomplete.
 */
export function parseJudgeScores(
  judgeOutput: string,
  def: ScenarioDef,
): Record<string, number> | null {
  for (const candidate of candidateJsonObjects(judgeOutput)) {
    const scores = tryParseScores(candidate, def);
    if (scores) return scores;
  }
  return parsePlainTextScores(judgeOutput, def);
}
