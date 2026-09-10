/**
 * Endpoint URL helpers. Accepts a bare host (http://localhost:11434),
 * an API base (http://host:8000/v1), or a full completions path.
 */
export function normalizeEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildRequestUrl(config: { endpoint: string }): string {
  return normalizeEndpoint(config.endpoint);
}