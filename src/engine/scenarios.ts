/**
 * llm-bench-style scenario definitions: four fixed tasks (agent, code,
 * narrative, research), each with its own temperature and judge rubric.
 * Prompts are faithful equivalents of the methodology's described tasks;
 * the judge dimensions and weights match the published methodology.
 */
export interface JudgeDimension {
  key: string;
  name: string;
  /** Weight in the scenario KPI, 0-100 total across dimensions. */
  weight: number;
  /** What the judge should look for. */
  criteria: string;
}

export interface ScenarioDef {
  id: 'agent' | 'code' | 'narrative' | 'research';
  name: string;
  focus: string;
  temperature: number;
  systemPrompt: string;
  prompt: string;
  dimensions: JudgeDimension[];
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'agent',
    name: 'Agent Workflow',
    focus: 'Tool-use and action planning',
    temperature: 0.4,
    systemPrompt:
      'You are a meticulous planning agent. You reason step by step and produce ' +
      'structured, verifiable plans. You never claim to have used a tool you did not use.',
    prompt:
      'You have access to (hypothetical) tools: search_web(query), read_file(path), ' +
      'send_email(to, subject, body), schedule_event(title, datetime, duration_minutes), ' +
      'run_code(language, code).\n\n' +
      'Task: Plan the launch of a community tech meetup (60 attendees, $400 budget, ' +
      '6 weeks from today). Produce a numbered plan. For each step give: the goal, the ' +
      'tool you would use (from the list above), its inputs, the expected output, and at ' +
      'least one risk with its mitigation. End with a dependency summary (which steps ' +
      'block which).',
    dimensions: [
      {
        key: 'coherence',
        name: 'Reasoning coherence',
        weight: 35,
        criteria: 'Steps connect logically; no contradictions or circular dependencies.',
      },
      {
        key: 'toolSelection',
        name: 'Tool selection',
        weight: 35,
        criteria: 'Each step uses the appropriate tool from the provided list for its goal.',
      },
      {
        key: 'decomposition',
        name: 'Sub-task decomposition',
        weight: 20,
        criteria: 'The launch is broken into manageable, independently checkable steps.',
      },
      {
        key: 'errorHandling',
        name: 'Error handling',
        weight: 10,
        criteria: 'Risks are identified per step and mitigations are concrete.',
      },
    ],
  },
  {
    id: 'code',
    name: 'Code Generation',
    focus: 'Complete Breakout game in one HTML file',
    temperature: 0.3,
    systemPrompt:
      'You are an expert game programmer. You write complete, working, self-contained ' +
      'code with no placeholders or omissions.',
    prompt:
      'Write a complete, self-contained single HTML file implementing a playable ' +
      'Breakout (brick-breaker) game using the HTML5 Canvas and vanilla JavaScript.\n' +
      'Requirements:\n' +
      '- grid of colored bricks, different points per row;\n' +
      '- ball physics with spin derived from where it hits the paddle;\n' +
      '- collision: ball-walls, ball-paddle, ball-bricks;\n' +
      '- paddle controlled by keyboard arrows AND touch drag;\n' +
      '- score, lives, game over screen, restart without reload;\n' +
      '- game loop via requestAnimationFrame.\n' +
      'Output ONLY the HTML file inside one fenced code block.',
    dimensions: [
      {
        key: 'correctness',
        name: 'Correctness',
        weight: 40,
        criteria:
          'State management is clear (grid, ball, paddle); collision detection covers ' +
          'walls, paddle and bricks; game-over and restart logic actually work.',
      },
      {
        key: 'quality',
        name: 'Code quality',
        weight: 30,
        criteria: 'Readable structure, sensible names, no dead code or copy-paste blocks.',
      },
      {
        key: 'performance',
        name: 'Performance',
        weight: 20,
        criteria: 'Uses requestAnimationFrame and canvas; no DOM-element sprite abuse.',
      },
      {
        key: 'completeness',
        name: 'Completeness',
        weight: 10,
        criteria: 'All stated requirements present; nothing left as TODO or stub.',
      },
    ],
  },
  {
    id: 'narrative',
    name: 'Role Play & Narrative',
    focus: 'Long-form character roleplay',
    temperature: 0.8,
    systemPrompt:
      'You are Kestra Vane, captain of a smuggler freighter — forty years old, ' +
      'scarred, dry-witted, loyal to your crew above every credit. You despise ' +
      'betrayal; money has never bought you before. Write in first person, with ' +
      'sensory detail: engine rumble, recycled air, cold steel.',
    prompt:
      'Kestra, a syndicate broker just offered you 50,000 credits to hand your own ' +
      'crew over to them. Write the scene in your cabin after the offer: what the ' +
      'money smells like against what they ask; one memory of how your engineer once ' +
      'saved your life; the churn of the decision in dialogue with yourself. End the ' +
      'scene with what you do when your engineer knocks on the hatch — your choice ' +
      'must be binary and character-true. 600-900 words.',
    dimensions: [
      {
        key: 'consistency',
        name: 'Character consistency',
        weight: 30,
        criteria:
          'Kestra stays in voice; loyalty vs greed tension is authentic to the ' +
          'established character; the ending choice fits her.',
      },
      {
        key: 'immersion',
        name: 'Immersion',
        weight: 35,
        criteria: 'Sensory grounding (smell, sound, touch); the scene feels inhabited.',
      },
      {
        key: 'dialogue',
        name: 'Dialogue quality',
        weight: 20,
        criteria: 'Voice-authentic internal/extern dialogue that reveals character.',
      },
      {
        key: 'arc',
        name: 'Narrative arc',
        weight: 15,
        criteria: 'Clear progression from temptation through memory to a binary decision.',
      },
    ],
  },
  {
    id: 'research',
    name: 'Research & Analysis',
    focus: 'Complex reasoning and synthesis',
    temperature: 0.5,
    systemPrompt:
      'You are a rigorous performance analyst. You show your calculations, separate ' +
      'facts from inference, and state confidence levels for predictions.',
    prompt:
      'Benchmark results for three inference setups on four tasks:\n\n' +
      '| setup | summarization t/s | code-gen t/s | chat t/s | batch t/s |\n' +
      '| A (Ollama, 8B Q4)  | 38.2 | 24.1 | 41.5 | 52.0 |\n' +
      '| B (llama.cpp, 8B Q4) | 35.9 | 27.8 | 40.2 | 61.3 |\n' +
      '| C (vLLM, 8B FP8) | 62.4 | 58.1 | 65.0 | 71.7 |\n\n' +
      'Analyze per-task scaling (NOT overall averages). Show every calculation ' +
      '(e.g. ratio per task of C vs A). Infer the underlying bottleneck for each ' +
      'task from the pattern. Recommend one setup for a latency-sensitive chatbot ' +
      'and one for a nightly offline batch pipeline, each with an explicit ' +
      'confidence level (high/medium/low) and a quantified limitation of your ' +
      'analysis (e.g. "batch figures ±10% due to single-run variance"). ' +
      'Length: 700-1,000 words.',
    dimensions: [
      {
        key: 'depth',
        name: 'Depth of research',
        weight: 30,
        criteria: 'All required sections present; scaling analyzed per task, not overall.',
      },
      {
        key: 'insight',
        name: 'Insight generation',
        weight: 35,
        criteria:
          'Comparisons reflect task-specific differences; patterns explained, not just observed.',
      },
      {
        key: 'interpretation',
        name: 'Data interpretation',
        weight: 25,
        criteria:
          'Calculations shown and correct; predictions carry confidence levels; limitations quantified.',
      },
      {
        key: 'clarity',
        name: 'Clarity',
        weight: 10,
        criteria: 'Recommendations specific and tied to the numbers.',
      },
    ],
  },
];

/** Strip chain-of-thought wrappers before judging (llm-bench scores answers, not thinking). */
export function stripThink(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // unterminated think block at the tail
    .trim();
}

/** Weighted KPI for a scenario: mean of dimension scores times their weights (weights sum to 100). */
export function weightedKpi(
  dimensions: JudgeDimension[],
  scores: Record<string, number>,
): number | null {
  const total = dimensions.reduce((a, d) => a + d.weight, 0);
  if (total <= 0) return null;
  let sum = 0;
  for (const d of dimensions) {
    const s = scores[d.key];
    if (typeof s !== 'number' || !Number.isFinite(s)) return null;
    sum += s * d.weight;
  }
  return sum / total;
}

/** llm-bench efficiency ratio: tokens per second per GB of resident VRAM. */
export function efficiencyRatio(tps: number | null, vramBytes: number | null): number | null {
  if (tps === null || !Number.isFinite(tps) || tps <= 0 || vramBytes === null || vramBytes <= 0) {
    return null;
  }
  return tps / (vramBytes / 1024 ** 3);
}
