import { assertHarnessConformance } from "@infino-ai/analytics-core/conformance";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { createFoundryHarness } from "../src/index.js";
import type { McpToolset } from "../src/mcp.js";

// Fixtures for the REAL createFoundryHarness — both provider boundaries are
// stubbed, so this exercises the shipped abort/error/done semantics rather
// than a lookalike.
const ev = (e: unknown) => e as ResponseStreamEvent;

const TEXT_TURN: ResponseStreamEvent[] = [
  ev({ type: "response.created", response: { id: "resp_1" } }),
  ev({ type: "response.output_text.delta", delta: "25,296 rows." }),
  ev({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "25,296 rows." }] } }),
  ev({ type: "response.completed", response: { id: "resp_1", usage: { total_tokens: 10 } } }),
];

const TOOL_TURN: ResponseStreamEvent[] = [
  ev({ type: "response.created", response: { id: "resp_0" } }),
  ev({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "infino_sql", arguments: '{"query":"SELECT COUNT(*) FROM t"}' } }),
  ev({ type: "response.completed", response: { id: "resp_0", usage: { total_tokens: 10 } } }),
];

const fakeMcp: McpToolset = {
  tools: [{ type: "function", name: "infino_sql", description: "run sql", parameters: { type: "object" }, strict: false }],
  pid: null,
  call: async () => ({ text: "[{\"n\":25296}]", isError: false }),
  close: async () => {},
};

function harness(turns: ResponseStreamEvent[][], fail = false) {
  let served = 0;
  return createFoundryHarness(
    { infino: { uri: "https://example.test/db", apiKey: "test" }, model: "test-model" },
    {
      connectMcp: async () => fakeMcp,
      stream: async (_body, { signal }) => {
        signal.throwIfAborted();
        if (fail) throw new Error("provider exploded");
        const events = turns[served++] ?? [];
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  );
}

assertHarnessConformance("foundry", {
  answersText: () => harness([TEXT_TURN]),
  callsTool: () => harness([TOOL_TURN, TEXT_TURN]),
  providerFails: () => harness([], true),
});
