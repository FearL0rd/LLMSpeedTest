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
      `Rubric (score each dimension 0-100):\n${rubric}\n\n` +
      `Answer to evaluate:\n"""\n${answer}\n"""\n\n` +
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
 * Parse judge JSON into validated per-dimension scores (integers/clamped 0-100).
 * Returns null when the output is unparseable or missing required dimensions.
 */
export function parseJudgeScores(
  judgeOutput: string,
  def: ScenarioDef,
): Record<string, number> | null {
  const jsonText = extractJsonObject(judgeOutput);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const raw = (record.scores ?? record) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const d of def.dimensions) {
    const value = raw[d.key];
    const num = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (typeof num !== 'number' || !Number.isFinite(num)) return null;
    scores[d.key] = Math.max(0, Math.min(100, Math.round(num)));
  }
  return scores;
}
