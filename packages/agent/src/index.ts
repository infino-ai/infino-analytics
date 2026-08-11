import { createRequire } from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { InfinoClient, type InfinoConfig } from "@infino-ai/analytics-viz-core";
import { buildLocalTools } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { type ChatEvent } from "@infino-ai/analytics-viz-core";

export type { ChatEvent } from "@infino-ai/analytics-viz-core";

// ── Tool policy ───────────────────────────────────────────────────────────
// Split by what a tool can REACH, not by whether it's built-in.
//
// AUTO-APPROVED ("dontAsk" runs these without a prompt):
//   - the Infino engine over MCP + our create_chart tool — the core surface;
//   - WebSearch / WebFetch — analytical enrichment (industry benchmarks,
//     current prices, definitions). The model decides when a question needs
//     outside context. These reach the public internet, not this server's
//     host, so they carry none of the credential risk the host tools do.
//     (WebFetch retrieves model-chosen URLs — an SSRF surface; a hardened
//     deployment behind internal services may drop it.)
const ALLOWED_TOOLS = ["mcp__infino-engine__*", "mcp__fino__*", "WebSearch", "WebFetch"];

// DENIED regardless of the above. Under "dontAsk", allowedTools only
// AUTO-APPROVES its entries — it does NOT gate the SDK's other built-ins
// (verified: Bash ran while unlisted). These execute on the machine running
// this server, whose environment holds the Infino and Anthropic API keys, so
// a prompt-injected command could exfiltrate them. Keep them denied.
//
// Want the agent to run code (Python/pandas) for heavier analysis? In the
// Agent SDK that is Bash-on-host — there is no sandbox here, so it is the
// SAME switch as "let the agent read our API keys." Enable it ONLY in an
// isolated deployment (a container with the keys kept out of the
// child-process environment and egress restricted) by removing "Bash" below.
// Never on a host that can see your secrets.
const DENIED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Task",
  "Agent",
];

// Ceiling on tool-use round trips per question; a runaway loop stops here.
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MODEL = "claude-opus-5";
// Hard spend ceiling per question — insurance against pathological runs.
const DEFAULT_MAX_BUDGET_USD = 2;

export interface AgentConfig {
  infino: InfinoConfig;
  /** Anthropic model id; the LLM seam's default harness is the Claude Agent
   * SDK, so this is a Claude model. Swapping the harness replaces this file,
   * not the tools or prompts. */
  model?: string;
  maxTurns?: number;
  /** Per-question spend ceiling in USD (default 2). */
  maxBudgetUsd?: number;
  /** Anthropic API key; falls back to ANTHROPIC_API_KEY in the environment. */
  anthropicApiKey?: string;
}

export interface AgentRunResult {
  sessionId?: string;
}

/** Run one question through the agent, yielding typed events. Returns the
 * SDK session id so a follow-up can resume the conversation. */
export async function* runAgent(params: {
  question: string;
  config: AgentConfig;
  resumeSessionId?: string;
  /** Abort cancels the underlying run (the model stops, tools stop) — not
   * just the event stream. Wire client disconnects to this. */
  signal?: AbortSignal;
}): AsyncGenerator<ChatEvent, AgentRunResult> {
  const client = new InfinoClient(params.config.infino);

  const abortController = new AbortController();
  if (params.signal) {
    if (params.signal.aborted) abortController.abort();
    else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  // Side channel: tools push UI-bound events (sql, chart with full rows)
  // here so large payloads never pass through the model's context. Drained
  // into the outbound stream between SDK messages.
  const pending: ChatEvent[] = [];
  const localTools = buildLocalTools(client, (e) => pending.push(e));

  const require = createRequire(import.meta.url);
  const infinoMcpEntry = require.resolve("@infino-ai/mcp-server");

  let sessionId: string | undefined;
  // The SDK's final result text repeats the last assistant text block;
  // track it so the summary isn't emitted twice.
  let lastAssistantText = "";

  const messages = query({
    prompt: params.question,
    options: {
      model: params.config.model ?? DEFAULT_MODEL,
      systemPrompt: buildSystemPrompt(),
      maxTurns: params.config.maxTurns ?? DEFAULT_MAX_TURNS,
      maxBudgetUsd: params.config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      abortController,
      includePartialMessages: true,
      resume: params.resumeSessionId,
      // The app defines the whole tool surface; don't inherit filesystem or
      // repo settings from wherever the server happens to run.
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DENIED_TOOLS,
      // Use exactly the servers configured here — user/project MCP settings
      // on the host machine must not leak into (or disable parts of) the
      // agent's tool surface.
      strictMcpConfig: true,
      mcpServers: {
        // The published @infino-ai/mcp-server, unmodified: list/describe
        // tables, BM25/hybrid/semantic search, and read-only SQL. (Named
        // "infino-engine" rather than "infino" so a host machine's per-name
        // MCP enable/disable state for a server called "infino" can't
        // silently disable it.)
        "infino-engine": {
          command: process.execPath,
          args: [infinoMcpEntry],
          env: {
            INFINO_MCP_URI: client.databaseUri,
            INFINO_API_KEY: params.config.infino.apiKey ?? process.env.INFINO_API_KEY ?? "",
          },
        },
        // In-process app tools: chart contract + grounding.
        fino: localTools,
      },
      env: params.config.anthropicApiKey
        ? { ...process.env, ANTHROPIC_API_KEY: params.config.anthropicApiKey }
        : undefined,
    },
  });

  try {
    for await (const message of messages) {
      yield* drain(pending);

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        continue;
      }

      if (message.type === "stream_event") {
        // Live signals: text chunks stream as deltas (the complete block
        // still arrives afterwards as a progress event and supersedes them);
        // thinking gets a transient status so pauses are never silent.
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "delta", text: event.delta.text };
        } else if (event.type === "content_block_start" && event.content_block.type === "thinking") {
          yield { type: "status", text: "thinking" };
        }
        continue;
      }

      if (message.type === "assistant") {
        const content = message.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text.trim()) {
            lastAssistantText = block.text.trim();
            yield { type: "progress", text: block.text };
          } else if (block.type === "tool_use") {
            // Persistent trace step: real tool name + input detail. The tool
            // executes right after this message, so the step shows while the
            // (potentially long) call runs.
            yield {
              type: "step",
              id: block.id,
              tool: String(block.name).split("__").pop() ?? block.name,
              detail: stepDetail(block.input as Record<string, unknown>),
            };
          }
        }
        continue;
      }

      if (message.type === "user") {
        // Tool results come back as user messages; close their trace steps.
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_result" && block.tool_use_id) {
              yield { type: "step_done", id: block.tool_use_id, ok: block.is_error !== true };
            }
          }
        }
        continue;
      }

      if (message.type === "result") {
        sessionId = message.session_id ?? sessionId;
        yield* drain(pending);
        if (message.subtype === "success") {
          if (message.result.trim() !== lastAssistantText) {
            yield { type: "summary", text: message.result };
          }
        } else {
          yield { type: "error", message: `agent stopped: ${message.subtype}` };
        }
        yield {
          type: "done",
          sessionId: sessionId ?? "",
          turns: message.num_turns,
          costUsd: message.total_cost_usd,
        };
      }
    }
    yield* drain(pending);
  } catch (err) {
    yield* drain(pending);
    if (abortController.signal.aborted) {
      // Cancellation is a normal outcome, not an error.
      yield { type: "done", sessionId: sessionId ?? "" };
    } else {
      const messageText = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: messageText };
      yield { type: "done", sessionId: sessionId ?? "" };
    }
  }

  return { sessionId };
}

function* drain(queue: ChatEvent[]): Generator<ChatEvent> {
  while (queue.length > 0) yield queue.shift() as ChatEvent;
}

// One-line input summary for a trace step: prefer the payload the user would
// recognize (the SQL text, the table, the chart title) over raw JSON.
const STEP_DETAIL_MAX = 160;
function stepDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const detail =
    (pick(input.title) ? `${pick(input.chart_type) ?? "chart"} · ${pick(input.title)}` : undefined) ??
    pick(input.query) ??
    pick(input.sql) ??
    pick(input.table) ??
    (Object.keys(input).length ? JSON.stringify(input) : undefined);
  if (!detail) return undefined;
  return detail.length > STEP_DETAIL_MAX ? `${detail.slice(0, STEP_DETAIL_MAX)}…` : detail;
}
