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
