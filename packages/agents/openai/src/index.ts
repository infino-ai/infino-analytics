import OpenAI, { APIError } from "openai";
import {
  InfinoClient,
  buildSystemPrompt,
  drain,
  type AgentHarness,
  type ChatEvent,
  type InfinoConfig,
} from "@infino-ai/analytics-core";
import { connectInfinoMcp } from "./mcp.js";
import { runTurns, type LoopStats, type StreamFn } from "./loop.js";
import { buildToolRegistry } from "./tools.js";

// A second harness behind the same ChatEvent contract: the OpenAI Responses
// API, with the Infino data tools over MCP. Any deployment that speaks it
// works — api.openai.com or an Azure OpenAI / AI Foundry resource — because
// the only thing that varies is baseURL.
//
// Deliberate differences from the Claude harness, all invisible to consumers:
//   - `done.costUsd` is omitted. The API reports tokens, not cost, and a
//     hardcoded price table rots; the ceiling is maxTotalTokens instead.
//   - No `summary` event. The Responses API has no second copy of the final
//     text, so a summary would only duplicate the last `progress`.
//   - No web search. The prompt drops that promise accordingly.

const DEFAULT_MAX_TURNS = 25;
// Insurance against a pathological run, in place of the Claude harness's
// per-question USD ceiling.
const DEFAULT_MAX_TOTAL_TOKENS = 400_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface OpenAIConfig {
  infino: InfinoConfig;
  /** Full API base, no path building. Falls back to OPENAI_BASE_URL.
   *   OpenAI: https://api.openai.com/v1
   *   Azure:  https://<resource>.openai.azure.com/openai/v1 */
  baseURL?: string;
  /** Falls back to OPENAI_API_KEY. Sent as a bearer token; the v1 surface
   * takes no api-version, on Azure either. */
  apiKey?: string;
  /** Model id, or an Azure deployment name. Falls back to OPENAI_MODEL. */
  model?: string;
  /** Operator-supplied notes about the dataset, appended to the system prompt
   * as ground truth. Dataset knowledge, so it applies here exactly as it does
   * to the Claude harness. */
  domainContext?: string;
  maxTurns?: number;
  /** Cumulative billed tokens per question (default 400k). */
  maxTotalTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  requestTimeoutMs?: number;
}

/** The two provider boundaries, injectable so the conformance suite can drive
 * the real harness without an endpoint or a child process. Production passes
 * neither. */
export interface OpenAISeams {
  /** Replaces the streaming Responses call. */
  stream?: StreamFn;
  /** Replaces the stdio MCP connection. */
  connectMcp?: typeof connectInfinoMcp;
}

/** Build the OpenAI harness. Model configuration is closed over here, so the
 * facade only ever sees the AgentHarness signature. */
export function createOpenAIHarness(config: OpenAIConfig, seams: OpenAISeams = {}): AgentHarness {
  const model = required(config.model ?? process.env.OPENAI_MODEL, "OPENAI_MODEL");
  const connect = seams.connectMcp ?? connectInfinoMcp;

  // The plain client, not AzureOpenAI: that one injects an api-version and
  // rewrites paths for deployment-scoped routes, which the v1 surface rejects.
  // Skipped entirely when the caller supplies its own stream.
  const client = seams.stream
    ? undefined
    : new OpenAI({
        baseURL: required(config.baseURL ?? process.env.OPENAI_BASE_URL, "OPENAI_BASE_URL"),
        apiKey: required(config.apiKey ?? process.env.OPENAI_API_KEY, "OPENAI_API_KEY"),
        timeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });

  return async function* openaiHarness(params) {
    const abort = new AbortController();
    if (params.signal) {
      if (params.signal.aborted) abort.abort();
      else params.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    const infino = new InfinoClient(config.infino);
    const pending: ChatEvent[] = [];
    const stats: LoopStats = { turns: 0, totalTokens: 0 };
    let sessionId = params.resumeSessionId;

    const mcp = await connect({
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
    const stream: StreamFn =
      seams.stream ??
      (async (body, { signal }) => {
        const api = client as OpenAI;
        try {
          return await api.responses.create(body, { signal });
        } catch (err) {
          if (!body.previous_response_id || !isStaleResponseId(err)) throw err;
          return api.responses.create({ ...body, previous_response_id: undefined }, { signal });
        }
      });

    try {
      const result = yield* runTurns({
        question: params.question,
        // No web-search tool on this path, so the contract must not offer one.
        instructions: buildSystemPrompt({ domainContext: config.domainContext }),
        model,
        previousResponseId: params.resumeSessionId,
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        maxTotalTokens: config.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
        reasoningEffort: config.reasoningEffort,
        tools: buildToolRegistry(mcp, infino, (e) => pending.push(e)),
        stream,
        pending,
        stats,
        signal: abort.signal,
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
  // Treated the same as any other API error.
  if (err instanceof APIError) {
    const code = typeof err.code === "string" ? err.code : String(err.status);
    return `agent stopped: ${code}${err.message ? ` — ${err.message.slice(0, 300)}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
