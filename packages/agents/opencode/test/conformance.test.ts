import { assertHarnessConformance } from "@infino-ai/analytics-core/conformance";
import type { Event } from "@opencode-ai/sdk/v2";
import { createOpencodeHarness, type OpencodeBackend } from "../src/index.js";

// Fixtures for the REAL createOpencodeHarness: only the opencode server is
// scripted, so this exercises the shipped abort/error/done semantics rather
// than a lookalike.
const SESSION = "ses_1";
const ev = (e: unknown) => e as Event;

const textPart = (text: string, end?: number) =>
  ev({
    type: "message.part.updated",
    properties: { sessionID: SESSION, part: { id: "prt_text", sessionID: SESSION, messageID: "msg_2", type: "text", text, time: { start: 1, end } } },
  });

const assistant = (id: string, cost: number) =>
  ev({
    type: "message.updated",
    properties: { sessionID: SESSION, info: { id, sessionID: SESSION, role: "assistant", parentID: "msg_q", cost, tokens: {} } },
  });

const idle = ev({ type: "session.idle", properties: { sessionID: SESSION } });
// opencode opens a run by going busy and recording the question, which every
// reply then names as its parent.
const busy = ev({ type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } });
const question = ev({ type: "message.updated", properties: { sessionID: SESSION, info: { id: "msg_q", sessionID: SESSION, role: "user" } } });

const TEXT_RUN: Event[] = [
  busy,
  question,
  assistant("msg_2", 0),
  textPart(""),
  ev({ type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_2", partID: "prt_text", field: "text", delta: "25,296 rows." } }),
  textPart("25,296 rows.", 2),
  assistant("msg_2", 0.01),
  idle,
];

const toolPart = (state: Record<string, unknown>) =>
  ev({
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_tool", sessionID: SESSION, messageID: "msg_1", type: "tool", callID: "call_1", tool: "infino-engine_infino_sql", state },
    },
  });

const TOOL_RUN: Event[] = [
  busy,
  question,
  assistant("msg_1", 0),
  toolPart({ status: "pending", input: {}, raw: "" }),
  toolPart({ status: "running", input: { query: "SELECT COUNT(*) FROM t" }, time: { start: 1 } }),
  toolPart({ status: "completed", input: { query: "SELECT COUNT(*) FROM t" }, output: '[{"n":25296}]', title: "", metadata: {}, time: { start: 1, end: 2 } }),
  assistant("msg_1", 0.01),
  ...TEXT_RUN.slice(2),
];

const FAILED_RUN: Event[] = [
  busy,
  question,
  ev({ type: "session.error", properties: { sessionID: SESSION, error: { name: "ApiError", data: { message: "provider exploded" } } } }),
  idle,
];

function scripted(events: Event[]): OpencodeBackend {
  return {
    mcpServers: ["infino-engine", "fino"],
    createSession: async () => SESSION,
    hasSession: async () => true,
    isBusy: async () => false,
    prompt: async () => {},
    abort: async () => {},
    claimChart: () => [],
    subscribe: async (signal) =>
      (async function* () {
        for (const e of events) {
          if (signal.aborted) return;
          yield e;
        }
      })(),
  };
}

const harness = (events: Event[]) =>
  createOpencodeHarness({ infino: { uri: "https://example.test/db", apiKey: "test" } }, { backend: scripted(events) });

assertHarnessConformance("opencode", {
  answersText: () => harness(TEXT_RUN),
  callsTool: () => harness(TOOL_RUN),
  providerFails: () => harness(FAILED_RUN),
});
