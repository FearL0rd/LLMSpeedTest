/**
 * Natural-text prompt construction with server-calibrated token lengths.
 *
 * Instead of shipping a tokenizer, prompt sizes are calibrated against the
 * server's own `prompt_tokens` report (the same "adapt" approach
 * llama-benchy uses): probe, read actual prompt_tokens, rescale the text
 * length, repeat. Two iterations converge well because token/char ratio is
 * stable for natural text.
 */
import type { RunMetrics, StreamConfig } from '../types';

/** Public-domain source text (Conan Doyle, A Study in Scarlet, 1887). */
const CORPUS = `In the year 1878 I took my degree of Doctor of Medicine of the University
of London, and proceeded to Netley to go through the course prescribed for
surgeons in the army. Having completed my studies there, I was duly attached
to the Fifth Northumberland Fusiliers as Assistant Surgeon. The regiment was
stationed in India at the time, and before I could join it, the Afghan war
had broken out. On hearing the news, I hastened to rejoin the regiment. I
passed my examination with credit, and found myself at Portsmouth Dockyard.
There I stayed for some weeks, receiving my instructions, and making myself
useful in the infirmary, where the wounded were brought back from the front.
The campaign brought great honour and also great sorrow to many a household,
and the long march through the mountain passes tried the strength of the
stoutest soldiers of the Queen. When at last I returned to England, broken
in health and without a friend in the world, I made my way to London, where
fortune led me, by the strangest of chances, to rooms in Baker Street, and
to the acquaintance of a most remarkable man, Mr. Sherlock Holmes, who was
then engaged in studies that were destined to change the conduct of criminal
investigation throughout the civilised world. Together we shared those rooms,
and in the course of our long companionship I recorded many of the singular
cases which came to us, from the study of a severed hand upon a mantelpiece
to the affair of the engineer with the curious thumb-mark upon his lamp.`;

/** ~4 chars per token; consistent with the live-chart heuristic. */
const CHARS_PER_TOKEN = 4;

/**
 * Natural text sized for a target token count. Calibration fixes any drift
 * between this estimate and the server's tokenizer.
 */
export function textForTokens(targetTokens: number): string {
  if (targetTokens <= 0) return '';
  const chars = Math.max(1, Math.round(targetTokens * CHARS_PER_TOKEN));
  if (chars <= CORPUS.length) return CORPUS.slice(0, chars);
  const repeats = Math.floor(chars / CORPUS.length);
  const rest = chars - repeats * CORPUS.length;
  return CORPUS.repeat(repeats) + CORPUS.slice(0, rest);
}

export interface CalibrationProbe {
  (promptChars: number): Promise<number>;
}

/**
 * Find the character length whose server-reported prompt token count is
 * closest to target. Uses at most `maxProbes` streaming probes.
 */
export async function calibratePromptChars(
  probe: CalibrationProbe,
  targetTokens: number,
  maxProbes = 3,
): Promise<number> {
  if (targetTokens <= 0) return 0;
  let chars = targetTokens * CHARS_PER_TOKEN;
  for (let i = 0; i < maxProbes; i++) {
    const actual = await probe(chars);
    if (!Number.isFinite(actual) || actual <= 0) return chars;
    if (Math.abs(actual - targetTokens) / targetTokens < 0.05) return chars;
    chars = Math.max(32, Math.round((chars * targetTokens) / actual));
  }
  return chars;
}

/** Probe helper: sends the built prompt and returns server prompt_tokens. */
export function makeProbe(
  build: (promptText: string) => StreamConfig,
  run: (config: StreamConfig) => Promise<RunMetrics>,
): CalibrationProbe {
  return async (promptChars: number) => {
    const metrics = await run(build('x'.repeat(promptChars)));
    return metrics.promptTokens ?? metrics.enginePromptEvalCount ?? 0;
  };
}
