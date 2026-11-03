import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { embeddingEnv, parseEmbeddingConfig, probeEmbedding } from "../src/embedding.js";

const tei = { baseUrl: "https://embed.example.com/v1", model: "test-model" };
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe("embedding settings", () => {
  it("maps to the MCP server's variables, and to none when unset", () => {
    deepStrictEqual(embeddingEnv(undefined), {});
    const env = embeddingEnv(tei);
    strictEqual(env.INFINO_MCP_EMBED_BASE_URL, tei.baseUrl);
    strictEqual(env.INFINO_MCP_EMBED_MODEL, tei.model);
    ok(env.INFINO_MCP_EMBED_PROVIDER);
  });

  it("sends the API key only to the configured host", () => {
    const saved = { ...process.env };
    try {
      process.env.INFINO_MCP_EMBED_API_KEY = "secret";
      process.env.INFINO_MCP_EMBED_BASE_URL = tei.baseUrl;
      strictEqual(embeddingEnv(tei).INFINO_MCP_EMBED_API_KEY, "secret");
      strictEqual(embeddingEnv({ ...tei, baseUrl: "https://elsewhere.example.com/v1" }).INFINO_MCP_EMBED_API_KEY, undefined);
      delete process.env.INFINO_MCP_EMBED_BASE_URL;
      strictEqual(embeddingEnv(tei).INFINO_MCP_EMBED_API_KEY, undefined);
    } finally {
      process.env = saved;
    }
  });

  it("accepts http(s) URLs only and trims a trailing slash", () => {
    deepStrictEqual(parseEmbeddingConfig({ baseUrl: "https://embed.example.com/v1/", model: " m " }), {
      baseUrl: "https://embed.example.com/v1",
      model: "m",
    });
    throws(() => parseEmbeddingConfig({ baseUrl: "file:///etc/passwd", model: "m" }), /http or https/);
    throws(() => parseEmbeddingConfig({ baseUrl: "not a url", model: "m" }), /not a URL/);
    throws(() => parseEmbeddingConfig({ baseUrl: "https://embed.example.com", model: "" }), /baseUrl and a model/);
  });

  it("passes with the vector width, and fails on a width mismatch or a bad reply", async () => {
    const vec = { data: [{ embedding: Array(1024).fill(0.1) }] };
    const pass = await probeEmbedding(tei, { expectedDims: 1024, fetchFn: answering(vec) });
    ok(pass.ok);
    strictEqual(pass.dims, 1024);

    const wrong = await probeEmbedding(tei, { expectedDims: 768, fetchFn: answering(vec) });
    ok(!wrong.ok);
    strictEqual(wrong.dims, 1024);

    const down = await probeEmbedding(tei, { fetchFn: answering({ error: "loading" }, 502) });
    ok(!down.ok);
    match(down.error, /HTTP 502/);

    const empty = await probeEmbedding(tei, { fetchFn: answering({ data: [] }) });
    ok(!empty.ok);
  });
});
