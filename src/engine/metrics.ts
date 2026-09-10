import type { RawChunk, RunMetrics, SpeedSample, StreamConfig } from '../types';

/**
 * Live chart samples estimate token counts from chunk character length.
 * This is a display-only heuristic; final metrics prefer server-reported
 * usage counts (or Ollama's eval_count) so the headline numbers stay exact.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Accumulates timing and token statistics while a completion streams in.
 *
 * The accumulator intentionally owns small mutable internal state (it is a
 * builder); `finalize` returns a fresh immutable RunMetrics snapshot.
 * The clock is injectable so tests can drive deterministic timings.
 */
export class MetricsAccumulator {
  private readonly now: () => number;
  private startTime = 0;
  private firstChunkTime: number | null = null;
  private firstTokenTime: number | null = null;
  private lastTokenTime = 0;
  private lastSampleTime = 0;
  private cumulativeTokens = 0;
  private contentText = '';
  private finishReason: string | null = null;

  private promptTokens: number | null = null;
  private completionTokens: number | null = null;
  private totalTokens: number | null = null;

  private engineEvalCount: number | null = null;
  private enginePromptEvalCount: number | null = null;
  private engineEvalDurationNs: number | null = null;
  private enginePromptEvalDurationNs: number | null = null;

  private readonly samples: SpeedSample[] = [];
  private lastSampleIndex = 0;
  private chunkCount = 0;
  private contentChunkCount = 0;
  private usageChunkCount = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Record the request start instant. */
  start(): void {
    const t = this.now();
    this.startTime = t;
    this.lastSampleTime = t;
  }

  /** Ingest one parsed stream chunk. */
  ingest(raw: RawChunk): void {
    const t = this.now();
    if (this.firstChunkTime === null) {
      this.firstChunkTime = t;
    }
    this.chunkCount++;
    if (raw.usage) this.usageChunkCount++;

    if (raw.usage) {
      if (raw.usage.prompt_tokens != null) this.promptTokens = raw.usage.prompt_tokens;
      if (raw.usage.completion_tokens != null) this.completionTokens = raw.usage.completion_tokens;
      if (raw.usage.total_tokens != null) this.totalTokens = raw.usage.total_tokens;
    }
    if (raw.eval_count != null) this.engineEvalCount = raw.eval_count;
    if (raw.prompt_eval_count != null) this.enginePromptEvalCount = raw.prompt_eval_count;
    if (raw.eval_duration != null) this.engineEvalDurationNs = raw.eval_duration;
    if (raw.prompt_eval_duration != null) {
      this.enginePromptEvalDurationNs = raw.prompt_eval_duration;
    }

    let delta = '';
    if (raw.choices && raw.choices.length > 0) {
      const choice = raw.choices[0];
      // Thinking servers stream reasoning tokens via reasoning_content;
      // completion-style servers use text. Any of them is decode work.
      delta = choice.delta?.content ?? choice.delta?.reasoning_content ?? choice.text ?? '';
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    if (delta.length > 0) this.contentChunkCount++;

    if (delta.length > 0) {
      if (this.firstTokenTime === null) {
        this.firstTokenTime = t;
      }
      this.lastTokenTime = t;
      this.contentText += delta;

      const estTokens = Math.max(1, Math.round(delta.length / CHARS_PER_TOKEN));
      this.cumulativeTokens += estTokens;
      const dt = t - this.lastSampleTime;
      if (dt > 0) {
        this.samples.push({
          t: t - this.startTime,
          tokensPerSec: (estTokens / dt) * 1000,
          cumulativeTokens: this.cumulativeTokens,
        });
        this.lastSampleTime = t;
      }
    }
  }

  /** Text content received so far. */
  get content(): string {
    return this.contentText;
  }

  /** Live speed samples recorded so far. */
  get sampleList(): readonly SpeedSample[] {
    return this.samples;
  }

  /** Wall-clock ms from start to first token, once known. */
  get ttftMs(): number | null {
    return this.firstTokenTime === null ? null : this.firstTokenTime - this.startTime;
  }

  /** Wall-clock ms to the first chunk of any kind (TTFR). */
  get ttfrMs(): number | null {
    return this.firstChunkTime === null ? null : this.firstChunkTime - this.startTime;
  }

  /** Number of samples not yet consumed by the caller. */
  get pendingSampleCount(): number {
    return this.samples.length - this.lastSampleIndex;
  }

  /** Samples appended since the last take, marking them consumed. */
  takeNewSamples(): SpeedSample[] {
    const fresh = this.samples.slice(this.lastSampleIndex);
    this.lastSampleIndex = this.samples.length;
    return fresh;
  }

  /** Compute the final metrics snapshot. Safe on partial/failed streams. */
  finalize(): RunMetrics {
    const totalTimeMs = this.now() - this.startTime;
    const ttftMs = this.ttftMs;
    const ttfrMs = this.ttfrMs;
    const decodeTimeMs =
      this.firstTokenTime === null ? 0 : Math.max(0, this.lastTokenTime - this.firstTokenTime);

    const completionTokens = this.completionTokens ?? this.engineEvalCount ?? null;
    const promptTokens = this.promptTokens ?? this.enginePromptEvalCount ?? null;
    const totalTokens =
      this.totalTokens ??
      (promptTokens !== null || completionTokens !== null
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : null);

    let tps: number | null = null;
    let tpotMs: number | null = null;
    if (completionTokens !== null && completionTokens > 0 && decodeTimeMs > 0) {
      tps = completionTokens / (decodeTimeMs / 1000);
      tpotMs = decodeTimeMs / completionTokens;
    }

    let engineTps: number | null = null;
    let engineTpotMs: number | null = null;
    if (
      this.engineEvalCount !== null &&
      this.engineEvalCount > 0 &&
      this.engineEvalDurationNs !== null &&
      this.engineEvalDurationNs > 0
    ) {
      const evalSeconds = this.engineEvalDurationNs / 1e9;
      engineTps = this.engineEvalCount / evalSeconds;
      engineTpotMs = (evalSeconds / this.engineEvalCount) * 1000;
    }
    const engineTtftMs =
      this.enginePromptEvalDurationNs !== null && this.enginePromptEvalDurationNs > 0
        ? this.enginePromptEvalDurationNs / 1e6
        : null;

    const tpsValues = this.samples.map((s) => s.tokensPerSec);
    const peakTps = tpsValues.length > 0 ? Math.max(...tpsValues) : null;
    const minTps = tpsValues.length > 0 ? Math.min(...tpsValues) : null;
    const meanTps =
      tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : null;
    const peakWindowTps = peakWindow(this.samples);

    return {
      ttfrMs,
      ttftMs,
      totalTimeMs,
      decodeTimeMs,
      promptTokens,
      completionTokens,
      totalTokens,
      tps,
      tpotMs,
      peakTps,
      meanTps,
      minTps,
      peakWindowTps,
      estPptMs: null,
      ppTps: null,
      engineTps,
      engineTpotMs,
      engineTtftMs,
      engineEvalCount: this.engineEvalCount,
      enginePromptEvalCount: this.enginePromptEvalCount,
      finishReason: this.finishReason,
      content: this.contentText,
      samples: [...this.samples],
      diagnostics: {
        chunks: this.chunkCount,
        contentChunks: this.contentChunkCount,
        usageChunks: this.usageChunkCount,
      },
    };
  }
}

/** Highest tokens/sec over any trailing 1-second window of estimated tokens. */
export function peakWindow(samples: readonly SpeedSample[]): number | null {
  let peak: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    let j = i;
    while (j > 0 && samples[i].t - samples[j - 1].t <= 1000) j--;
    const start = j > 0 ? samples[j - 1] : null;
    const spanMs = samples[i].t - (start?.t ?? 0);
    if (spanMs <= 0) continue;
    const tokens = samples[i].cumulativeTokens - (start?.cumulativeTokens ?? 0);
    const tps = (tokens / spanMs) * 1000;
    peak = peak === null ? tps : Math.max(peak, tps);
  }
  return peak;
}

/** Build the request start snapshot used for labeling a saved run. */
export function runLabel(config: StreamConfig): string {
  return config.label?.trim() || config.model;
}

/** Format helper shared by UI components. */
export function fmt(value: number | null | undefined, digits = 1, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}