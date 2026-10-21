import { assertHarnessConformance } from "@infino-ai/analytics-core/conformance";
import type { Event } from "@opencode-ai/sdk/v2";
import { createOpencodeHarness, type OpencodeBackend } from "../src/index.js";

// Fixtures for the REAL createOpencodeHarness: only the opencode server is
// scripted, so this exercises the shipped abort/error/done semantics rather
// than a lookalike. A script is a function of the question id, because
// opencode records the question under the id the run sends it with.
const SESSION = "ses_1";
const ev = (e: unknown) => e as Event;
type Script = (questionId: string) => Event[];

const textPart = (text: string, end?: number) =>
  ev({
    type: "message.part.updated",
    properties: { sessionID: SESSION, part: { id: "prt_text", sessionID: SESSION, messageID: "msg_2", type: "text", text, time: { start: 1, end } } },
  });

const assistant = (id: string, parentID: string, cost: number) =>
  ev({
    type: "message.updated",
    properties: { sessionID: SESSION, info: { id, sessionID: SESSION, role: "assistant", parentID, cost, tokens: {} } },
  });

const idle = ev({ type: "session.idle", properties: { sessionID: SESSION } });
// opencode opens a run by going busy and recording the question, which every
// reply then names as its parent.
const opening = (q: string) => [
  ev({ type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } }),
  ev({ type: "message.updated", properties: { sessionID: SESSION, info: { id: q, sessionID: SESSION, role: "user" } } }),
];

const answer = (q: string) => [
  assistant("msg_2", q, 0),
  textPart(""),
  ev({ type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_2", partID: "prt_text", field: "text", delta: "25,296 rows." } }),
  textPart("25,296 rows.", 2),
  assistant("msg_2", q, 0.01),
  idle,
];

const TEXT_RUN: Script = (q) => [...opening(q), ...answer(q)];

const toolPart = (state: Record<string, unknown>) =>
  ev({
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_tool", sessionID: SESSION, messageID: "msg_1", type: "tool", callID: "call_1", tool: "infino-engine_infino_sql", state },
    },
  });

const TOOL_RUN: Script = (q) => [
  ...opening(q),
  assistant("msg_1", q, 0),
  toolPart({ status: "pending", input: {}, raw: "" }),
  toolPart({ status: "running", input: { query: "SELECT COUNT(*) FROM t" }, time: { start: 1 } }),
  toolPart({ status: "completed", input: { query: "SELECT COUNT(*) FROM t" }, output: '[{"n":25296}]', title: "", metadata: {}, time: { start: 1, end: 2 } }),
  assistant("msg_1", q, 0.01),
  ...answer(q),
];

const FAILED_RUN: Script = (q) => [
  ...opening(q),
  ev({ type: "session.error", properties: { sessionID: SESSION, error: { name: "ApiError", data: { message: "provider exploded" } } } }),
  idle,
];

function scripted(script: Script): OpencodeBackend {
  let questionId: string | undefined;
  return {
    mcpServers: ["infino-engine", "fino"],
    createSession: async () => SESSION,
    hasSession: async () => true,
    isBusy: async () => false,
    prompt: async (_session, _text, messageId) => {
      questionId = messageId;
    },
    abort: async () => {},
    claimChart: () => [],
    subscribe: async (signal) =>
      (async function* () {
        while (!questionId) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 1));
        }
        for (const e of script(questionId)) {
          if (signal.aborted) return;
          yield e;
        }
      })(),
  };
}

const harness = (script: Script) =>
  createOpencodeHarness({ infino: { uri: "https://example.test/db", apiKey: "test" } }, { backend: scripted(script) });

assertHarnessConformance("opencode", {
  answersText: () => harness(TEXT_RUN),
  callsTool: () => harness(TOOL_RUN),
  providerFails: () => harness(FAILED_RUN),
});
