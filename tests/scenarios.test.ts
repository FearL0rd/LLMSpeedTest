import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  efficiencyRatio,
  stripThink,
  weightedKpi,
} from '../src/engine/scenarios';
import { buildJudgePrompt, extractJsonObject, parseJudgeScores } from '../src/engine/judge';
import { findModelMemory, parseOllamaPs, pickGpu } from '../src/engine/probe';
import type { ProbeResult } from '../src/engine/probe';

describe('scenario definitions', () => {
  it('covers the four llm-bench scenarios at per-task temperatures', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['agent', 'code', 'narrative', 'research']);
    expect(new Set(SCENARIOS.map((s) => s.temperature)).size).toBe(4);
  });

  it('judge weights sum to 100 per scenario', () => {
    for (const s of SCENARIOS) {
      const total = s.dimensions.reduce((a, d) => a + d.weight, 0);
      expect(total).toBe(100);
    }
  });
});

describe('stripThink', () => {
  it('removes think blocks but keeps the answer', () => {
    expect(stripThink('<think>work work</think>The answer is 4.')).toBe('The answer is 4.');
    expect(stripThink('<thinking>draft</thinking>\n\nFinal: yes.')).toBe('Final: yes.');
    expect(stripThink('No thinking here.')).toBe('No thinking here.');
  });

  it('handles an unterminated think tail', () => {
    expect(stripThink('Answer first. <think>never ended')).toBe('Answer first.');
  });
});

describe('weightedKpi', () => {
  const agent = SCENARIOS[0];

  it('computes the weighted mean of dimension scores', () => {
    const kpi = weightedKpi(agent.dimensions, {
      coherence: 80,
      toolSelection: 90,
      decomposition: 70,
      errorHandling: 60,
    });
    // (80*35 + 90*35 + 70*20 + 60*10) / 100
    expect(kpi).toBeCloseTo(79.5, 6);
  });

  it('returns null when a dimension score is missing', () => {
    expect(
      weightedKpi(agent.dimensions, { coherence: 80, toolSelection: 90, decomposition: 70 }),
    ).toBeNull();
  });
});

describe('efficiencyRatio', () => {
  it('tokens per second per GB of VRAM', () => {
    expect(efficiencyRatio(60, 8 * 1024 ** 3)).toBeCloseTo(7.5, 6);
    expect(efficiencyRatio(null, 8 * 1024 ** 3)).toBeNull();
    expect(efficiencyRatio(60, null)).toBeNull();
    expect(efficiencyRatio(60, 0)).toBeNull();
  });
});

describe('judge prompts and parsing', () => {
  const agent = SCENARIOS[0];

  it('builds a rubric prompt naming every dimension', () => {
    const { systemPrompt, prompt } = buildJudgePrompt(agent, 'the plan');
    expect(systemPrompt).toContain('JSON');
    for (const d of agent.dimensions) {
      expect(prompt).toContain(d.key);
      expect(prompt).toContain(String(d.weight));
    }
    expect(prompt).toContain('the plan');
  });

  it('extracts JSON from prose and from code fences', () => {
    expect(extractJsonObject('Sure! {"scores":{"a":1}} done')).toBe('{"scores":{"a":1}}');
    expect(extractJsonObject('```json\n{"scores":{"a":2}}\n```')).toBe('{"scores":{"a":2}}');
    expect(extractJsonObject('no json at all')).toBeNull();
  });

  it('parses valid scores and clamps to 0-100', () => {
    const out = parseJudgeScores(
      '{"scores":{"coherence":81,"toolSelection":101,"decomposition":"70","errorHandling":-4}}',
      agent,
    );
    expect(out).toEqual({
      coherence: 81,
      toolSelection: 100,
      decomposition: 70,
      errorHandling: 0,
    });
  });

  it('rejects missing dimensions and non-JSON output', () => {
    expect(
      parseJudgeScores('{"scores":{"coherence":80,"toolSelection":90}}', agent),
    ).toBeNull();
    expect(parseJudgeScores('the answer was great', agent)).toBeNull();
  });

  it('tolerates key spelling variants from chatty judges', () => {
    const out = parseJudgeScores(
      '{"Scores": {"Coherence": 81, "tool_selection": 90, "decomposition": 70, "error handling": 60}}',
      agent,
    );
    expect(out).toEqual({
      coherence: 81,
      toolSelection: 90,
      decomposition: 70,
      errorHandling: 60,
    });
  });

  it('ignores braces in surrounding prose', () => {
    const out = parseJudgeScores(
      'I computed {these} scores: {"scores": {"coherence": 80, "toolSelection": 88, "decomposition": 75, "errorHandling": 65}} (as {expected})',
      agent,
    );
    expect(out).toEqual({
      coherence: 80,
      toolSelection: 88,
      decomposition: 75,
      errorHandling: 65,
    });
  });

  it('parses plain-text scores from judges that ignore the JSON instruction', () => {
    const code = SCENARIOS[1];
    const out = parseJudgeScores(
      'We need to evaluate the provided code against the rubric.\n' +
        '- correctness: 85\n- quality: 90\n- performance: 70\n- completeness: 60',
      code,
    );
    expect(out).toEqual({
      correctness: 85,
      quality: 90,
      performance: 70,
      completeness: 60,
    });
  });

  it('parses scores written as N/100', () => {
    const code = SCENARIOS[1];
    const out = parseJudgeScores(
      'correctness: 85/100, quality: 90/100, performance: 70/100, completeness: 60/100',
      code,
    );
    expect(out).toEqual({
      correctness: 85,
      quality: 90,
      performance: 70,
      completeness: 60,
    });
  });

  it('does not mistake rubric echoes (weight percentages) for scores', () => {
    const out = parseJudgeScores(
      '- correctness (40%): State management clear\n- toolSelection (35%): ok',
      agent,
    );
    expect(out).toBeNull();
  });

  it('puts the answer before the JSON instruction with a no-think switch', () => {
    const { prompt } = buildJudgePrompt(agent, 'the plan');
    expect(prompt.indexOf('the plan')).toBeLessThan(prompt.indexOf('Respond with exactly'));
    expect(prompt).toContain('/no_think');
  });
});

describe('pickGpu (local GPU sampling)', () => {
  const gpu = (name: string, used: number, total: number, util: number | null = null) => ({
    name,
    memoryUsedBytes: used,
    memoryTotalBytes: total,
    utilizationPercent: util,
  });

  it('picks the GPU serving the model (highest used memory)', () => {
    const stats = [gpu('GTX 1060', 0, 3 * 1024 ** 3), gpu('RTX 3090', 5 * 1024 ** 3, 24 * 1024 ** 3)];
    expect(pickGpu(stats)?.name).toBe('RTX 3090');
  });

  it('falls back to highest total when nothing is loaded', () => {
    const stats = [gpu('GTX 1060', 0, 3 * 1024 ** 3), gpu('V100', 0, 32 * 1024 ** 3)];
    expect(pickGpu(stats)?.name).toBe('V100');
  });

  it('handles empty lists', () => {
    expect(pickGpu([])).toBeNull();
  });
});

describe('Ollama /api/ps parsing', () => {
  it('reads size, VRAM and the CPU/GPU split', () => {
    const list = parseOllamaPs(
      JSON.stringify({
        models: [
          {
            name: 'qwen3:8b',
            size: 8_589_934_592,
            size_vram: 8_589_934_592,
            processor: '0%/100% CPU/GPU',
          },
        ],
      }),
    );
    expect(list).toEqual([
      {
        model: 'qwen3:8b',
        bytes: 8_589_934_592,
        totalBytes: 8_589_934_592,
        gpuPercent: 100,
      },
    ]);
  });

  it('parses partial GPU splits like 30%/70%', () => {
    const list = parseOllamaPs(
      JSON.stringify({
        models: [{ name: 'm', size_vram: 100, processor: '30%/70% CPU/GPU' }],
      }),
    );
    expect(list[0].gpuPercent).toBe(70);
  });

  it('findModelMemory matches the tested model and falls back to a single entry', () => {
    const probes: ProbeResult[] = [
      {
        path: '/api/ps',
        status: 200,
        body: JSON.stringify({ models: [{ name: 'qwen3:8b', size_vram: 100 }] }),
      },
    ];
    expect(findModelMemory(probes, 'qwen3:8b')?.bytes).toBe(100);
    // Single loaded model: tolerate name-shape differences like 'qwen3:8b' vs 'qwen3:8b-Q4'.
    expect(findModelMemory(probes, 'qwen3:8b-Q4')?.model).toBe('qwen3:8b');
    expect(findModelMemory([], 'x')).toBeNull();

    const two: ProbeResult[] = [
      {
        path: '/api/ps',
        status: 200,
        body: JSON.stringify({
          models: [
            { name: 'a:1b', size_vram: 10 },
            { name: 'b:2b', size_vram: 20 },
          ],
        }),
      },
    ];
    expect(findModelMemory(two, 'unrelated')).toBeNull();
  });
});
