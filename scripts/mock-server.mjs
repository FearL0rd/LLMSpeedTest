// Mock OpenAI-compatible SSE server for tests and browser verification.
// Emits tokens at a variable rate (with deliberate stutter) and reports
// standard usage plus Ollama-style extension fields in the final chunk.
//
// Usage: node scripts/mock-server.mjs
// Env:   PORT (default 15201), MOCK_TOKENS (default 60), MOCK_MODEL (default mock-7b)
import http from 'node:http';

const PORT = process.env.PORT ? Number(process.env.PORT) : 15201;
const TOKENS = Number(process.env.MOCK_TOKENS || 60);
const MODEL = process.env.MOCK_MODEL || 'mock-7b-instruct';
const ENGINE = process.env.MOCK_ENGINE || 'ollama'; // 'ollama' | 'llamacpp'
const PP_MS_PER_TOKEN = Number(process.env.MOCK_PP_MS || 0.15); // prefill speed
const WORD = 'lorem '; // 6 chars -> ~1.5 estimated tokens per chunk

// Naive prefix-cache emulation: identical system prompts prefill instantly.
const ctxCache = new Map();
function cacheKey(systemText) {
  return systemText ? systemText.length + ':' + systemText.slice(0, 64) + ':' + systemText.slice(-32) : '';
}

function estimateTokens(text) {
  return Math.max(1, Math.round(text.length / 4));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }

  // Engine-style probe endpoints so detection can be exercised.
  if (ENGINE === 'ollama' && req.method === 'GET' && req.url.endsWith('/api/version')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ version: '0.5.7-mock' }));
    return;
  }
  if (ENGINE === 'ollama' && req.method === 'GET' && req.url.endsWith('/api/ps')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        models: [
          {
            name: `${MODEL}:Q4_K_M`,
            size: 4_100_000_000,
            size_vram: 3_963_612_866,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
        ],
      })
    );
    return;
  }
  if (ENGINE === 'llamacpp' && req.method === 'GET' && req.url.endsWith('/props')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        model_path: '/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        total_slots: 1,
        default_generation_settings: { model: `${MODEL}`, n_predict: -1 },
      })
    );
    return;
  }

  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const systemText = (payload.messages || [])
      .filter((m) => m.role === 'system')
      .map((m) => m.content || '')
      .join('\n');
    const userText = (payload.messages || [])
      .filter((m) => m.role !== 'system')
      .map((m) => m.content || '')
      .join(' ');
    const promptTokens = estimateTokens(systemText + ' ' + userText);

    // Output length: min_tokens <= n <= max_tokens (cap: TOKENS * 8).
    let n = TOKENS;
    if (payload.max_tokens) n = Math.min(n, payload.max_tokens);
    if (payload.min_tokens) n = Math.max(n, payload.min_tokens);
    n = Math.max(1, Math.min(n, TOKENS * 8));

    // Answer coherence-check questions like a real model would.
    const isCoherence = /2\s*\+\s*2/i.test(userText);
    if (isCoherence) n = 1;
    const contentToken = isCoherence ? '4' : WORD;

    // Prefill: proportional to prompt tokens; cache hits are near-instant.
    const key = cacheKey(systemText);
    const cacheHit = systemText ? ctxCache.has(key) : false;
    if (systemText && payload.cache_prompt !== false) ctxCache.set(key, true);
    const prefillMs = cacheHit ? 25 : Math.max(90, promptTokens * PP_MS_PER_TOKEN);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const start = Date.now();
    let i = 0;

    const sendFinal = () => {
      const evalMs = Date.now() - start;
      const final = {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: n,
          total_tokens: promptTokens + n,
        },
        prompt_eval_count: promptTokens,
        eval_count: n,
        prompt_eval_duration: Math.round((cacheHit ? 25 : evalMs) * 1_000_000), // ns
        eval_duration: Math.round(evalMs * 1_000_000), // ns
      };
      res.write(`data: ${JSON.stringify(final)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // Variable cadence: sinusoidal stutter so the live chart has shape.
    const step = () => {
      if (i >= n || res.destroyed) {
        sendFinal();
        return;
      }
      const delay = 55 + Math.sin(i / 4) * 32 + 8; // ~30..95 ms
      setTimeout(() => {
        const chunk = { choices: [{ delta: { content: contentToken }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i += 1;
        step();
      }, delay);
    };
    // Simulated prefill latency before the first token.
    setTimeout(step, prefillMs);

    req.on('close', () => {
      res.destroyed = true;
    });
  });
});

server.listen(PORT, () => {
  console.log(`mock LLM server listening on http://localhost:${PORT} (model: ${MODEL})`);
});