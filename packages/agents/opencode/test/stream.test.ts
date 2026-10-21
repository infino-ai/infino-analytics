import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@opencode-ai/sdk/v2";
import type { ChatEvent } from "@infino-ai/analytics-core";
import { createEventMapper } from "../src/stream.js";

const S = "ses_1";
const Q = "msg_question";
const ev = (e: unknown) => e as Event;
const CHART: ChatEvent = { type: "sql", query: "SELECT 1" };

function mapper(opts: { claimed?: string[]; abortedByRun?: boolean } = {}) {
  return createEventMapper({
    sessionId: S,
    questionId: Q,
    mcpServers: ["infino-engine", "fino"],
    claimChart: (output) => {
      opts.claimed?.push(output ?? "");
      return [CHART];
    },
    abortedByRun: () => opts.abortedByRun ?? false,
  });
}

const user = (id: string) => ev({ type: "message.updated", properties: { sessionID: S, info: { id, role: "user" } } });
const reply = (id: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "message.updated", properties: { sessionID: S, info: { id, role: "assistant", parentID: Q, cost: 0, ...extra } } });
const status = (type: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "session.status", properties: { sessionID: S, status: { type, ...extra } } });
const idle = ev({ type: "session.idle", properties: { sessionID: S } });
const sessionError = (name: string, message = "") =>
  ev({ type: "session.error", properties: { sessionID: S, error: { name, data: { message } } } });
const part = (messageID: string, p: Record<string, unknown>) =>
  ev({ type: "message.part.updated", properties: { sessionID: S, part: { sessionID: S, messageID, ...p } } });
const tool = (messageID: string, name: string, state: Record<string, unknown>) =>
  part(messageID, { id: "p_tool", type: "tool", callID: "c1", tool: name, state });

/** A mapper that has seen this run's question and one reply, "a". */
function asked(opts: Parameters<typeof mapper>[0] = {}) {
  const m = mapper(opts);
  m.push(status("busy"));
  m.push(user(Q));
  m.push(reply("a"));
  return m;
}

describe("opencode event mapper", () => {
  it("ignores events from other sessions", () => {
    const m = asked();
    deepStrictEqual(m.push(ev({ type: "session.idle", properties: { sessionID: "ses_other" } })), []);
    strictEqual(m.outcome().ended, false);
  });

  it("streams deltas for answer text only, then one progress when the part ends", () => {
    const m = asked();
    m.push(part("a", { id: "p_r", type: "reasoning", text: "" }));
    m.push(part("a", { id: "p_t", type: "text", text: "" }));
    const delta = (partID: string) =>
      m.push(ev({ type: "message.part.delta", properties: { sessionID: S, messageID: "a", partID, field: "text", delta: "hi" } }));
    deepStrictEqual(delta("p_r"), [], "reasoning deltas stay out of the answer stream");
    deepStrictEqual(delta("p_t"), [{ type: "delta", text: "hi" }]);
    deepStrictEqual(m.push(part("a", { id: "p_t", type: "text", text: "hi", time: { start: 1 } })), []);
    deepStrictEqual(m.push(part("a", { id: "p_t", type: "text", text: "hi", time: { start: 1, end: 2 } })), [{ type: "progress", text: "hi" }]);
    deepStrictEqual(m.push(part("a", { id: "p_t", type: "text", text: "hi", time: { start: 1, end: 2 } })), [], "a resent final part is not repeated");
  });

  it("signals thinking once per reasoning part", () => {
    const m = asked();
    deepStrictEqual(m.push(part("a", { id: "p_r", type: "reasoning", text: "" })), [{ type: "status", text: "thinking" }]);
    deepStrictEqual(m.push(part("a", { id: "p_r", type: "reasoning", text: "more" })), []);
  });

  it("opens a step when input arrives and closes it once, with the server prefix stripped", () => {
    const m = asked();
    deepStrictEqual(m.push(tool("a", "infino-engine_infino_sql", { status: "pending", input: {} })), []);
    deepStrictEqual(m.push(tool("a", "infino-engine_infino_sql", { status: "running", input: { query: "SELECT 1" } })), [
      { type: "step", id: "c1", tool: "infino_sql", detail: "SELECT 1" },
    ]);
    deepStrictEqual(m.push(tool("a", "infino-engine_infino_sql", { status: "completed", input: { query: "SELECT 1" }, output: "[]" })), [
      { type: "step_done", id: "c1", ok: true, result: "[]" },
    ]);
    deepStrictEqual(m.push(tool("a", "infino-engine_infino_sql", { status: "completed", input: {}, output: "[]" })), []);
  });

  it("opens the step even when opencode skips the running state", () => {
    const events = asked().push(tool("a", "infino-engine_infino_sql", { status: "error", input: { query: "x" }, error: "boom" }));
    deepStrictEqual(events, [
      { type: "step", id: "c1", tool: "infino_sql", detail: "x" },
      { type: "step_done", id: "c1", ok: false, result: "boom" },
    ]);
  });

  it("releases a chart's parked events before its step closes", () => {
    const claimed: string[] = [];
    const m = asked({ claimed });
    m.push(tool("a", "fino_create_chart", { status: "running", input: { title: "t" } }));
    const events = m.push(tool("a", "fino_create_chart", { status: "completed", input: { title: "t" }, output: '{"chart":{"title":"t"}}' }));
    deepStrictEqual(events.map((e) => e.type), ["sql", "step_done"]);
    deepStrictEqual(claimed, ['{"chart":{"title":"t"}}']);
  });

  it("drops every part of a previous run's replies", () => {
    const m = asked();
    m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id: "old", role: "assistant", parentID: "msg_earlier", cost: 9 } } }));
    deepStrictEqual(m.push(part("old", { id: "p_old", type: "text", text: "stale", time: { start: 1, end: 2 } })), []);
    deepStrictEqual(m.push(part("old", { id: "p_or", type: "reasoning", text: "" })), []);
    deepStrictEqual(m.push(tool("old", "infino-engine_infino_sql", { status: "running", input: { query: "x" } })), []);
    deepStrictEqual({ cost: m.outcome().costUsd, turns: m.outcome().turns }, { cost: 0, turns: 1 }, "nor is its cost this run's");
  });

  it("never treats the question itself, or a user message from before it, as part of the run", () => {
    const m = mapper();
    m.push(user("msg_earlier"));
    m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id: "r0", role: "assistant", parentID: "msg_earlier", cost: 1 } } }));
    m.push(user(Q));
    deepStrictEqual(m.push(part(Q, { id: "p_q", type: "text", text: "question?", time: { start: 1, end: 2 } })), []);
    strictEqual(m.outcome().turns, 0);
  });

  it("keeps compaction's summary out of the answer but counts its cost", () => {
    const m = asked();
    m.push(user("msg_compaction"));
    m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id: "sum", role: "assistant", parentID: "msg_compaction", cost: 0.5, summary: true } } }));
    deepStrictEqual(m.push(part("sum", { id: "p_s", type: "text", text: "SUMMARY-OF-CONVERSATION", time: { start: 1, end: 2 } })), []);
    // The answer continues after compaction, under the continue prompt.
    m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id: "cont", role: "assistant", parentID: "msg_compaction", cost: 0.25 } } }));
    deepStrictEqual(m.push(part("cont", { id: "p_c", type: "text", text: "the answer", time: { start: 1, end: 2 } })), [{ type: "progress", text: "the answer" }]);
    strictEqual(m.outcome().costUsd, 0.75);
  });

  it("ends only on an idle after this run's question", () => {
    const m = mapper();
    m.push(idle);
    strictEqual(m.outcome().ended, false, "a previous run's idle");
    m.push(status("busy"));
    m.push(idle);
    strictEqual(m.outcome().ended, false, "a previous run's busy and idle");
    m.push(user(Q));
    m.push(idle);
    strictEqual(m.outcome().ended, true);
  });

  it("does not fail a run that opencode recovered by compacting", () => {
    const m = asked();
    m.push(sessionError("ContextOverflowError", "too long"));
    strictEqual(m.outcome().failure, undefined);
  });

  it("treats this run's own abort as no failure, and anyone else's as a cancelled answer", () => {
    const own = asked({ abortedByRun: true });
    own.push(sessionError("MessageAbortedError", "Aborted"));
    strictEqual(own.outcome().failure, undefined);

    const other = asked({ abortedByRun: false });
    other.push(sessionError("MessageAbortedError", "Aborted"));
    strictEqual(other.outcome().failure, "agent stopped: the answer was cancelled");
  });

  it("ends at once on an error that comes before opencode went busy", () => {
    const m = mapper();
    m.push(sessionError("ProviderAuthError", "bad key"));
    deepStrictEqual({ ended: m.outcome().ended, failure: m.outcome().failure }, { ended: true, failure: "agent stopped: ProviderAuthError — bad key" });
  });

  it("waits for idle after an error that comes while busy", () => {
    const m = asked();
    m.push(sessionError("ApiError", "quota"));
    deepStrictEqual({ ended: m.outcome().ended, failure: m.outcome().failure }, { ended: false, failure: "agent stopped: ApiError — quota" });
  });

  it("sums the latest cost of each reply", () => {
    const m = asked();
    m.push(reply("a", { cost: 0.5 }));
    m.push(reply("b", { cost: 0.25 }));
    deepStrictEqual({ cost: m.outcome().costUsd, turns: m.outcome().turns }, { cost: 0.75, turns: 2 });
  });

  for (const type of ["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"]) {
    it(`flags a run that stops on ${type}`, () => {
      const m = asked();
      m.push(ev({ type, properties: { sessionID: S, id: "req_1" } }));
      strictEqual(m.outcome().blocked, `agent stopped: opencode asked for input (${type})`);
    });
  }

  it("surfaces a provider retry as a status", () => {
    deepStrictEqual(mapper().push(status("retry", { attempt: 1, message: "rate limited", next: 0 })), [
      { type: "status", text: "retrying: rate limited" },
    ]);
  });
});
