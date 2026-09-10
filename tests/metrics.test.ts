import { describe, expect, it } from 'vitest';
import { MetricsAccumulator } from '../src/engine/metrics';
import type { RawChunk } from '../src/types';

/** Deterministic clock: tests move time forward explicitly. */
function createClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const content = (text: string): RawChunk => ({
  choices: [{ delta: { content: text }, finish_reason: null }],
});

const finalWithUsage = (prompt: number, completion: number): RawChunk => ({
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  },
});

describe('MetricsAccumulator', () => {
  it('computes TTFT, TPS and TPOT from a standard OpenAI-style stream', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(200); // prefill latency
    acc.ingest(content('hello'));
    clock.advance(400);
    acc.ingest(content(' world'));
    clock.advance(600);
    acc.ingest(content('!'));
    clock.advance(50);
    acc.ingest(finalWithUsage(12, 10));

    const m = acc.finalize();

    expect(m.ttftMs).toBe(200);
    expect(m.decodeTimeMs).toBe(1000); // 200 -> 1200
    expect(m.totalTimeMs).toBe(1250);
    expect(m.promptTokens).toBe(12);
    expect(m.completionTokens).toBe(10);
    expect(m.totalTokens).toBe(22);
    expect(m.finishReason).toBe('stop');
    // 10 completion tokens over a 1s decode window
    expect(m.tps).toBeCloseTo(10, 5);
    expect(m.tpotMs).toBeCloseTo(100, 5);
    // live samples: 'hello' -> 1 tok/200ms = 5 tps; ' world' -> 2 tok/400ms = 5 tps; '!' -> 1 tok/600ms
    expect(m.samples).toHaveLength(3);
    expect(m.peakTps).toBeCloseTo(5, 5);
    expect(m.minTps).toBeCloseTo(1 + 2 / 3, 3);
    expect(m.meanTps).toBeGreaterThan(0);
    expect(m.content).toBe('hello world!');
  });

  it('parses Ollama extension fields into engine metrics', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(100);
    acc.ingest(content('hi'));
    clock.advance(900);
    acc.ingest({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      prompt_eval_count: 12,
      eval_count: 10,
      prompt_eval_duration: 300_000_000,
      eval_duration: 2_000_000_000,
    });

    const m = acc.finalize();

    expect(m.engineEvalCount).toBe(10);
    expect(m.enginePromptEvalCount).toBe(12);
    expect(m.engineTps).toBeCloseTo(5, 5); // 10 tokens / 2s
    expect(m.engineTpotMs).toBeCloseTo(200, 5); // 2s / 10 tokens
    expect(m.engineTtftMs).toBeCloseTo(300, 5); // 300ms prefill
  });

  it('falls back to Ollama eval_count when usage is absent', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(50);
    acc.ingest(content('hey'));
    clock.advance(950);
    acc.ingest({ choices: [{ delta: {}, finish_reason: 'stop' }], eval_count: 8, prompt_eval_count: 5 });

    const m = acc.finalize();

    expect(m.completionTokens).toBe(8);
    expect(m.promptTokens).toBe(5);
    expect(m.totalTokens).toBe(13);
  });

  it('counts reasoning_content and text deltas as token flow', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(100);
    acc.ingest({ choices: [{ delta: { reasoning_content: 'thinking ' } }] });
    clock.advance(100);
    acc.ingest({ choices: [{ text: 'answer ' }] });
    clock.advance(100);
    acc.ingest({ choices: [{ delta: { content: '4' }, finish_reason: 'stop' }] });

    const m = acc.finalize();

    expect(m.ttftMs).toBe(100);
    expect(m.content).toBe('thinking answer 4');
    expect(m.diagnostics).toEqual({ chunks: 3, contentChunks: 3, usageChunks: 0 });
  });

  it('reports diagnostics that explain blank decode metrics', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();
    clock.advance(100);
    acc.ingest({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 512, completion_tokens: 1, total_tokens: 513 },
    });

    const m = acc.finalize();

    // Usage-only stream: TTFR works, decode metrics cannot exist.
    expect(m.diagnostics).toEqual({ chunks: 1, contentChunks: 0, usageChunks: 1 });
    expect(m.ttfrMs).toBe(100);
    expect(m.ttftMs).toBeNull();
    expect(m.tps).toBeNull();
    expect(m.peakWindowTps).toBeNull();
  });

  it('survives an empty stream without producing NaN metrics', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();
    clock.advance(250);

    const m = acc.finalize();

    expect(m.ttftMs).toBeNull();
    expect(m.tps).toBeNull();
    expect(m.tpotMs).toBeNull();
    expect(m.completionTokens).toBeNull();
    expect(m.totalTokens).toBeNull();
    expect(m.peakTps).toBeNull();
    expect(m.decodeTimeMs).toBe(0);
    expect(m.samples).toHaveLength(0);
  });

  it('keeps partial metrics when the stream fails mid-flight', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(120);
    acc.ingest(content('partial '));
    clock.advance(80);
    acc.ingest(content('response'));

    const m = acc.finalize();

    expect(m.ttftMs).toBe(120);
    expect(m.content).toBe('partial response');
    expect(m.finishReason).toBeNull();
  });

  it('exposes incremental samples for live chart updates', () => {
    const clock = createClock();
    const acc = new MetricsAccumulator(clock.now);
    acc.start();

    clock.advance(100);
    acc.ingest(content('a'));
    expect(acc.pendingSampleCount).toBe(1);
    expect(acc.takeNewSamples()).toHaveLength(1);
    expect(acc.pendingSampleCount).toBe(0);

    clock.advance(100);
    acc.ingest(content('bb'));
    expect(acc.pendingSampleCount).toBe(1);
    expect(acc.sampleList).toHaveLength(2);
  });
});