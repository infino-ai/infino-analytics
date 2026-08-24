import type { ExecuteResult, VizSpec } from "./spec.js";

// The chat-run event vocabulary — the contract between any agent harness and
// every consumer (facade, HTTP server, frontends). It lives here, in the
// contract layer, so the agent harness stays a replaceable implementation:
// a fork swapping the LLM writes a generator that yields these and touches
// nothing else.
export type ChatEvent =
  | { type: "status"; text: string } // transient activity label ("thinking…"); replaces the previous one
  // A tool call, as a persistent trace step: real tool name + a short input
  // detail (the SQL text, the table name). step_done marks it finished.
  | { type: "step"; id: string; tool: string; detail?: string }
  | { type: "step_done"; id: string; ok: boolean }
  | { type: "delta"; text: string } // streamed text chunk; superseded by the next progress/summary
  | { type: "progress"; text: string }
  | { type: "sql"; query: string }
  | {
      type: "data";
      columns: { name: string; type: string }[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    }
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
