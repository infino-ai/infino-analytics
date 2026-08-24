import OpenAI, { APIError } from "openai";
import {
  InfinoClient,
  drain,
  type AgentHarness,
  type ChatEvent,
  type InfinoConfig,
} from "@infino-ai/analytics-core";
import { connectInfinoMcp } from "./mcp.js";
import { buildSystemPrompt } from "./prompt.js";
import { runTurns, type LoopStats, type StreamFn } from "./loop.js";
import { buildToolRegistry } from "./tools.js";

// A second harness behind the same ChatEvent contract: GPT-5 on Azure AI
// Foundry's Responses API, with the Infino data tools over MCP.
//
// Deliberate differences from the Claude harness, all invisible to consumers:
//   - `done.costUsd` is omitted. Azure reports tokens, not cost, and a
//     hardcoded price table rots; the ceiling is maxTotalTokens instead.
//   - No `summary` event. The Responses API has no second copy of the final
//     text, so a summary would only duplicate the last `progress`.
//   - No web search. The prompt drops that promise accordingly.

const DEFAULT_MAX_TURNS = 25;
// Insurance against a pathological run, in place of the Claude harness's
// per-question USD ceiling.
const DEFAULT_MAX_TOTAL_TOKENS = 400_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface FoundryConfig {
  infino: InfinoConfig;
  /** Azure OpenAI resource base; "openai/v1" is appended. Falls back to
   * FOUNDRY_OPENAI_ENDPOINT. */
  endpoint?: string;
  /** Falls back to FOUNDRY_API_KEY. Sent as a bearer token — the v1 surface
   * takes no api-version. */
  apiKey?: string;
  /** Deployment name, not a catalog model id. Falls back to
   * FOUNDRY_OPENAI_MODEL. */
  model?: string;
  maxTurns?: number;
  /** Cumulative billed tokens per question (default 400k). */
  maxTotalTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  requestTimeoutMs?: number;
}

/** Build the Foundry harness. Model configuration is closed over here, so
 * the facade only ever sees the AgentHarness signature. */
export function createFoundryHarness(config: FoundryConfig): AgentHarness {
  const endpoint = required(config.endpoint ?? process.env.FOUNDRY_OPENAI_ENDPOINT, "FOUNDRY_OPENAI_ENDPOINT");
  const apiKey = required(config.apiKey ?? process.env.FOUNDRY_API_KEY, "FOUNDRY_API_KEY");
  const model = required(config.model ?? process.env.FOUNDRY_OPENAI_MODEL, "FOUNDRY_OPENAI_MODEL");

  // The plain client, not AzureOpenAI: that one injects an api-version and
  // rewrites paths for deployment-scoped routes, which /openai/v1 rejects.
  const client = new OpenAI({
    baseURL: new URL("openai/v1", withTrailingSlash(endpoint)).toString(),
    apiKey,
    timeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  return async function* foundryHarness(params) {
    const abort = new AbortController();
    if (params.signal) {
      if (params.signal.aborted) abort.abort();
      else params.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    const infino = new InfinoClient(config.infino);
    const pending: ChatEvent[] = [];
    const stats: LoopStats = { turns: 0, totalTokens: 0 };
    let sessionId = params.resumeSessionId;

    const mcp = await connectInfinoMcp({
      databaseUri: infino.databaseUri,
      apiKey: config.infino.apiKey ?? process.env.INFINO_API_KEY ?? "",
    });
    // Two teardown paths, one close: the finally below covers normal and
    // error exits, while abort covers a consumer that abandons this generator
    // and so never reaches it.
    let closed = false;
    const closeOnce = async () => {
      if (closed) return;
      closed = true;
      await mcp.close().catch(() => {});
    };
    abort.signal.addEventListener("abort", () => void closeOnce(), { once: true });

    // A stored response expires (~30 days) and a reopened thread then points
    // at nothing. Dropping the pointer restarts the conversation, which the
    // thread contract already allows; the transcript still renders.
    const stream: StreamFn = async (body) => {
      try {
        return await client.responses.create(body, { signal: abort.signal });
      } catch (err) {
        if (!body.previous_response_id || !isStaleResponseId(err)) throw err;
        return client.responses.create(
          { ...body, previous_response_id: undefined },
          { signal: abort.signal },
        );
      }
    };

    try {
      const result = yield* runTurns({
        question: params.question,
        instructions: buildSystemPrompt(),
        model,
        previousResponseId: params.resumeSessionId,
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        maxTotalTokens: config.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
        reasoningEffort: config.reasoningEffort,
        tools: buildToolRegistry(mcp, infino, (e) => pending.push(e)),
        stream,
        pending,
        stats,
      });
      sessionId = result.sessionId ?? sessionId;
      yield* drain(pending);
      yield { type: "done", sessionId: sessionId ?? "", turns: stats.turns };
    } catch (err) {
      yield* drain(pending);
      // Cancellation is a normal outcome, not an error — same as the Claude
      // harness, and the UI depends on it.
      if (!abort.signal.aborted) {
        yield { type: "error", message: describe(err) };
      }
      yield { type: "done", sessionId: sessionId ?? "", turns: stats.turns };
    } finally {
      await closeOnce();
    }

    return { sessionId };
  };
}


/** A previous_response_id the provider no longer knows about. */
function isStaleResponseId(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  return (err.status === 404 || err.status === 400) && /previous_response|response with id/i.test(err.message ?? "");
}

function describe(err: unknown): string {
  // Azure surfaces content-filter blocks as a 400 rather than a stream event.
  if (err instanceof APIError) {
    const code = typeof err.code === "string" ? err.code : String(err.status);
    return `agent stopped: ${code}${err.message ? ` — ${err.message.slice(0, 300)}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
