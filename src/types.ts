/** Configuration for a single benchmark request. */
export interface StreamConfig {
  /** Base URL of the OpenAI-compatible server, e.g. http://localhost:11434 */
  endpoint: string;
  apiKey?: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the server to include usage in the final stream chunk. */
  includeUsage?: boolean;
  /** Free-form profile label used when saving runs for comparison. */
  label?: string;
  /** Hardware descriptor, e.g. "RTX 4090 · 24 GB" (remote endpoints) or auto-detected. */
  hardware?: string;
  /** Latency baseline measurement mode for est_ppt / prompt-processing speed. */
  latencyMode?: 'generation' | 'api' | 'none';
  /** Server-side output floor (exact-length runs; supported: vLLM, llama.cpp). */
  minTokens?: number;
  /** Ignore end-of-sequence for fixed-length generation (supported: vLLM, llama.cpp). */
  ignoreEos?: boolean;
}

/**
 * A single streamed chunk in a normalized shape. Only the fields we care
 * about are declared; unknown engine-specific fields are ignored.
 */
export interface RawChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** Thinking-style servers stream reasoning tokens here. */
      reasoning_content?: string | null;
      role?: string | null;
    };
    /** Completion-style (non-chat) servers stream plain text. */
    text?: string | null;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Ollama-style extension fields (native API and newer OpenAI-compatible responses). */
  prompt_eval_count?: number;
  eval_count?: number;
  /** Ollama durations are reported in nanoseconds. */
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/** One point on the live speed chart. */
export interface SpeedSample {
  /** Milliseconds since request start. */
  t: number;
  /** Instantaneous tokens/second estimated for the chunk that just arrived. */
  tokensPerSec: number;
  /** Cumulative estimated tokens so far. */
  cumulativeTokens: number;
}

/** Computed metrics for a completed (or partial) run. */
export interface RunMetrics {
  /** Time to first response: any stream data (incl. role-only chunks). */
  ttfrMs: number | null;
  /** Time to first content token. */
  ttftMs: number | null;
  totalTimeMs: number;
  decodeTimeMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Wall-clock tokens/sec over the decode phase. */
  tps: number | null;
  /** Wall-clock mean time per output token (ms). */
  tpotMs: number | null;
  peakTps: number | null;
  meanTps: number | null;
  minTps: number | null;
  /** Highest tokens/sec observed in any trailing 1-second window. */
  peakWindowTps: number | null;
  /** ttfrMs minus the measured baseline latency (server-side prefill estimate). */
  estPptMs: number | null;
  /** promptTokens ÷ estPpt — prompt processing (prefill) speed. */
  ppTps: number | null;
  /** Server-reported (e.g. Ollama eval_duration) equivalents, when available. */
  engineTps: number | null;
  engineTpotMs: number | null;
  engineTtftMs: number | null;
  engineEvalCount: number | null;
  enginePromptEvalCount: number | null;
  finishReason: string | null;
  content: string;
  samples: SpeedSample[];
  /** Protocol facts that explain blank metrics when a server streams oddly. */
  diagnostics: {
    chunks: number;
    contentChunks: number;
    usageChunks: number;
  };
}

/** A benchmark run persisted for later comparison. */
export interface SavedRun {
  id: string;
  label: string;
  model: string;
  endpoint: string;
  hardware?: string;
  createdAt: number;
  config: StreamConfig;
  metrics: RunMetrics;
}

/** Hardware of the machine the app itself runs on (Tauri only). */
export interface SystemInfo {
  os: string | null;
  cpu: string | null;
  coresPhysical: number | null;
  coresLogical: number;
  totalMemoryBytes: number;
  gpus: string[];
  disks: Array<{
    name: string;
    mountPoint: string;
    /** "SSD" | "HDD" | "Unknown" as reported by the OS. */
    kind: string;
    totalBytes: number;
    availableBytes: number;
  }>;
}

export type RunStatus = 'idle' | 'running' | 'done' | 'error';