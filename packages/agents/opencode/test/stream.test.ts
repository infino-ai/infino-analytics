import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@opencode-ai/sdk/v2";
import type { ChatEvent } from "@infino-ai/analytics-core";
import { createEventMapper } from "../src/stream.js";

const S = "ses_1";
const ev = (e: unknown) => e as Event;
const CHART: ChatEvent = { type: "sql", query: "SELECT 1" };

function mapper(claimed: string[] = []) {
  return createEventMapper({
    sessionId: S,
    mcpServers: ["infino-engine", "fino"],
    claimChart: (output) => {
      claimed.push(output ?? "");
      return [CHART];
    },
  });
}

const part = (p: Record<string, unknown>) =>
  ev({ type: "message.part.updated", properties: { sessionID: S, part: { sessionID: S, messageID: "m", ...p } } });

const question = ev({ type: "message.updated", properties: { sessionID: S, info: { id: "q", role: "user" } } });
const assistant = (id: string, parentID = "q") =>
  ev({ type: "message.updated", properties: { sessionID: S, info: { id, role: "assistant", parentID, cost: 0 } } });
const busy = ev({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
const idle = ev({ type: "session.idle", properties: { sessionID: S } });

const tool = (name: string, state: Record<string, unknown>) => part({ id: "p_tool", type: "tool", callID: "c1", tool: name, state });

describe("opencode event mapper", () => {
  it("ignores events from other sessions", () => {
    const m = mapper();
    deepStrictEqual(m.push(ev({ type: "session.idle", properties: { sessionID: "other" } })), []);
    strictEqual(m.outcome().idle, false);
  });

  it("streams deltas for text parts only, then one progress when the part ends", () => {
    const m = mapper();
    m.push(question);
    m.push(assistant("m"));
    m.push(part({ id: "p_r", type: "reasoning", text: "" }));
    m.push(part({ id: "p_t", type: "text", text: "" }));
    const delta = (partID: string) =>
      m.push(ev({ type: "message.part.delta", properties: { sessionID: S, messageID: "m", partID, field: "text", delta: "hi" } }));
    deepStrictEqual(delta("p_r"), [], "reasoning deltas stay out of the answer stream");
    deepStrictEqual(delta("p_t"), [{ type: "delta", text: "hi" }]);
    deepStrictEqual(m.push(part({ id: "p_t", type: "text", text: "hi", time: { start: 1 } })), []);
    deepStrictEqual(m.push(part({ id: "p_t", type: "text", text: "hi", time: { start: 1, end: 2 } })), [{ type: "progress", text: "hi" }]);
    deepStrictEqual(m.push(part({ id: "p_t", type: "text", text: "hi", time: { start: 1, end: 2 } })), [], "a resent final part is not repeated");
  });

  it("signals thinking once per reasoning part", () => {
    const m = mapper();
    deepStrictEqual(m.push(part({ id: "p_r", type: "reasoning", text: "" })), [{ type: "status", text: "thinking" }]);
    deepStrictEqual(m.push(part({ id: "p_r", type: "reasoning", text: "more" })), []);
  });

  it("opens a step when input arrives and closes it once, with the server prefix stripped", () => {
    const m = mapper();
    deepStrictEqual(m.push(tool("infino-engine_infino_sql", { status: "pending", input: {} })), []);
    deepStrictEqual(m.push(tool("infino-engine_infino_sql", { status: "running", input: { query: "SELECT 1" } })), [
      { type: "step", id: "c1", tool: "infino_sql", detail: "SELECT 1" },
    ]);
    deepStrictEqual(m.push(tool("infino-engine_infino_sql", { status: "completed", input: { query: "SELECT 1" }, output: "[]" })), [
      { type: "step_done", id: "c1", ok: true, result: "[]" },
    ]);
    deepStrictEqual(m.push(tool("infino-engine_infino_sql", { status: "completed", input: {}, output: "[]" })), []);
  });

  it("opens the step even when opencode skips the running state", () => {
    const events = mapper().push(tool("infino-engine_infino_sql", { status: "error", input: { query: "x" }, error: "boom" }));
    deepStrictEqual(events.map((e) => e.type), ["step", "step_done"]);
    strictEqual((events[1] as { ok: boolean }).ok, false);
  });

  it("releases a chart's parked events before its step closes", () => {
    const claimed: string[] = [];
    const m = mapper(claimed);
    m.push(tool("fino_create_chart", { status: "running", input: { title: "t" } }));
    const events = m.push(tool("fino_create_chart", { status: "completed", input: { title: "t" }, output: '{"chart":{"title":"t"}}' }));
    deepStrictEqual(events.map((e) => e.type), ["sql", "step_done"]);
    deepStrictEqual(claimed, ['{"chart":{"title":"t"}}']);
  });

  it("treats an aborted message as no failure, and any other error as one", () => {
    const m = mapper();
    m.push(ev({ type: "session.error", properties: { sessionID: S, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }));
    strictEqual(m.outcome().failure, undefined);
    m.push(ev({ type: "session.error", properties: { sessionID: S, error: { name: "ApiError", data: { message: "quota" } } } }));
    ok(m.outcome().failure?.includes("quota"));
  });

  it("sums the latest cost of each assistant message", () => {
    const m = mapper();
    const msg = (id: string, cost: number, parentID = "q") =>
      m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id, role: "assistant", parentID, cost } } }));
    m.push(question);
    msg("a", 0);
    msg("a", 0.5);
    msg("b", 0.25);
    msg("stale", 9, "an_earlier_question");
    deepStrictEqual({ cost: m.outcome().costUsd, turns: m.outcome().turns }, { cost: 0.75, turns: 2 }, "a previous run's reply is not counted");
  });

  it("never treats the user's own question as an answer", () => {
    const m = mapper();
    m.push(ev({ type: "message.updated", properties: { sessionID: S, info: { id: "u", role: "user" } } }));
    deepStrictEqual(m.push(part({ id: "p_q", messageID: "u", type: "text", text: "question?", time: { start: 1, end: 2 } })), []);
  });

  it("ignores an idle left over from before this run went busy", () => {
    const m = mapper();
    m.push(idle);
    strictEqual(m.outcome().idle, false, "a previous run's idle");
    m.push(busy);
    m.push(idle);
    strictEqual(m.outcome().idle, true);
  });

  it("surfaces a provider retry as a status", () => {
    const retry = ev({ type: "session.status", properties: { sessionID: S, status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } } });
    deepStrictEqual(mapper().push(retry), [{ type: "status", text: "retrying: rate limited" }]);
  });

  it("flags a run that stops to ask for permission", () => {
    const m = mapper();
    m.push(ev({ type: "permission.asked", properties: { sessionID: S, id: "perm_1" } }));
    ok(m.outcome().blocked);
  });
});
