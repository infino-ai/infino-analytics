import { assertHarnessConformance } from "@infino-ai/analytics-core/conformance";
import { createClaudeHarness, type QueryFn } from "../src/index.js";

// Fixtures for the REAL createClaudeHarness. The Agent SDK owns the turn loop
// and the MCP child process, so stubbing `query` stubs the whole provider —
// what remains under test is this harness's SDK-message → ChatEvent mapping
// and its terminal semantics.
const INIT = { type: "system", subtype: "init", session_id: "sess_1" };

const TEXT: unknown[] = [
  INIT,
  { type: "assistant", message: { content: [{ type: "text", text: "25,296 rows." }] } },
  { type: "result", subtype: "success", session_id: "sess_1", result: "25,296 rows.", num_turns: 1, total_cost_usd: 0.01 },
];

const TOOL: unknown[] = [
  INIT,
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "mcp__infino-engine__infino_sql", input: { query: "SELECT COUNT(*) FROM t" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "25,296 rows." }] } },
  { type: "result", subtype: "success", session_id: "sess_1", result: "25,296 rows.", num_turns: 2, total_cost_usd: 0.02 },
];

/** The SDK call returns an async iterable of messages; only iteration is
 * exercised here, so the cast covers the surface we do not touch. */
function fakeQuery(messages: unknown[], fail = false): QueryFn {
  return ((args: { options?: { abortController?: AbortController } }) =>
    (async function* () {
      // A real SDK call rejects on an aborted controller; a fake that ignores
      // it would make the kit's abort assertion vacuously pass.
      args.options?.abortController?.signal.throwIfAborted();
      if (fail) throw new Error("provider exploded");
      for (const m of messages) yield m;
    })()) as unknown as QueryFn;
}

const harness = (messages: unknown[], fail = false) =>
  createClaudeHarness(
    { infino: { uri: "https://example.test/db", apiKey: "test" } },
    fakeQuery(messages, fail),
  );

assertHarnessConformance("claude", {
  answersText: () => harness(TEXT),
  callsTool: () => harness(TOOL),
  providerFails: () => harness([], true),
});
