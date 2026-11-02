// The custom embedder, as the MCP server reads it (INFINO_MCP_EMBED_*), and a
// probe that checks an endpoint before anyone relies on it.

import type { EmbeddingConfig } from "./client.js";

// The key goes only to the host it was configured for, so a URL typed into
// the settings page cannot collect it.
function apiKeyFor(embedding: EmbeddingConfig): string | undefined {
  const key = process.env.INFINO_MCP_EMBED_API_KEY;
  const home = process.env.INFINO_MCP_EMBED_BASE_URL;
  if (!key || !home) return undefined;
  try {
    return new URL(home).origin === new URL(embedding.baseUrl).origin ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The MCP server's environment for this embedder; empty keeps its local model.
 * The API key comes only from INFINO_MCP_EMBED_API_KEY, for INFINO_MCP_EMBED_BASE_URL's host. */
export function embeddingEnv(embedding: EmbeddingConfig | undefined): Record<string, string> {
  if (!embedding) return {};
  const key = apiKeyFor(embedding);
  return {
    INFINO_MCP_EMBED_PROVIDER: "openai",
    INFINO_MCP_EMBED_BASE_URL: embedding.baseUrl,
    INFINO_MCP_EMBED_MODEL: embedding.model,
    ...(key ? { INFINO_MCP_EMBED_API_KEY: key } : {}),
  };
}

/** Validates untrusted input into an EmbeddingConfig; throws with the reason. */
export function parseEmbeddingConfig(input: unknown): EmbeddingConfig {
  const { baseUrl, model } = (input ?? {}) as Record<string, unknown>;
  if (typeof baseUrl !== "string" || typeof model !== "string" || !model.trim()) {
    throw new Error("embedding needs a baseUrl and a model");
  }
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error(`baseUrl is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must be http or https");
  return { baseUrl: url.href.replace(/\/$/, ""), model: model.trim() };
}

export type EmbeddingProbe =
  | { ok: true; dims: number; ms: number }
  | { ok: false; error: string; ms: number; dims?: number };

/** Embeds one short text the way the MCP server will, and reports the vector
 * width. With expectedDims, a different width fails the probe. Never throws. */
export async function probeEmbedding(
  embedding: EmbeddingConfig,
  opts: { expectedDims?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<EmbeddingProbe> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const key = apiKeyFor(embedding);
  try {
    const res = await (opts.fetchFn ?? fetch)(`${embedding.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: embedding.model, input: ["infino"] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, ms: ms() };
    const vector = ((await res.json()) as { data?: { embedding?: unknown }[] })?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      return { ok: false, error: "response has no data[0].embedding vector", ms: ms() };
    }
    if (opts.expectedDims && vector.length !== opts.expectedDims) {
      return {
        ok: false,
        dims: vector.length,
        error: `returns ${vector.length}-dimensional vectors; the table expects ${opts.expectedDims}`,
        ms: ms(),
      };
    }
    return { ok: true, dims: vector.length, ms: ms() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: ms() };
  }
}
