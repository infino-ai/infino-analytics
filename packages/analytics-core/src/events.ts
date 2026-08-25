import type { ExecuteResult, VizSpec } from "./spec.js";

// The chat-run event vocabulary — the contract between any agent harness and
// every consumer (facade, HTTP server, frontends). It lives here, in the
// contract layer, so the agent harness stays a replaceable implementation:
// a fork swapping the LLM writes a generator that yields these and touches
// nothing else.
export type ChatEvent =
  | { type: "status"; text: string } // transient activity label ("thinking…"); replaces the previous one
  // A tool call, as a persistent trace step: real tool name + a short input
  // detail (the SQL text, the table name). step_done marks it finished and
  // may carry a bounded text rendering of what the tool returned (the error
  // text when ok is false), so a trace UI can show request and response.
  | { type: "step"; id: string; tool: string; detail?: string }
  | { type: "step_done"; id: string; ok: boolean; result?: string }
  | { type: "delta"; text: string } // streamed text chunk; superseded by the next progress/summary
  | { type: "progress"; text: string }
  | { type: "sql"; query: string }
  | { type: "chart"; spec: VizSpec; result: ExecuteResult }
  | { type: "summary"; text: string }
  | { type: "error"; message: string }
  | {
      type: "done";
      sessionId: string;
      turns?: number;
      costUsd?: number;
    };

// Input summary for a trace step: prefer the payload the user would
// recognize (the SQL text, the table, the chart title) over raw JSON. Sent
// near-full so a UI can offer expand-to-read; display truncation is the
// renderer's job. Shared so every harness produces identical trace steps.
const STEP_DETAIL_MAX = 2000;

export function stepDetail(input: Record<string, unknown> | undefined): string | undefined {
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

// Result summary for a trace step: the tool's output as text, bounded at the
// source because step_done events are persisted with the transcript — a wide
// query result must not be stored in full a second time (the model already
// saw it; chart rows already ride the chart event). Shared so every harness
// renders results the same way.
export const STEP_RESULT_MAX = 4000;

export function stepResult(content: unknown): string | undefined {
  const text = flattenToolContent(content).trim();
  if (!text) return undefined;
  return text.length > STEP_RESULT_MAX ? `${text.slice(0, STEP_RESULT_MAX)}…` : text;
}

function flattenToolContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // MCP / provider tool results: [{type:"text", text}, ...]
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : flattenToolContent(block),
      )
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Flush a harness's side-channel queue into its outbound stream. Tools push
 * full result rows here so they reach the UI without entering model context;
 * a harness drains around every await. */
export function* drain(queue: ChatEvent[]): Generator<ChatEvent> {
  while (queue.length > 0) yield queue.shift() as ChatEvent;
}
