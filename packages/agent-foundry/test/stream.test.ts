import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { createTurnMapper } from "../src/stream.js";

// Event shapes captured verbatim from the live Foundry endpoint, so a change
// on their side shows up here rather than in production.
const ev = (e: unknown) => e as ResponseStreamEvent;

const created = (id: string) => ev({ type: "response.created", response: { id } });
const completed = (id: string, total = 0) =>
  ev({ type: "response.completed", response: { id, usage: { total_tokens: total } } });
const textDelta = (delta: string) => ev({ type: "response.output_text.delta", delta });
const message = (text: string) =>
  ev({
    type: "response.output_item.done",
    item: { type: "message", content: [{ type: "output_text", text }] },
  });
const callAdded = (name: string) =>
  ev({ type: "response.output_item.added", item: { type: "function_call", name, arguments: "" } });
const callDone = (callId: string, name: string, args: string) =>
  ev({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: callId, name, arguments: args },
  });

const run = (events: ResponseStreamEvent[]) => {
  const mapper = createTurnMapper();
  const out = events.flatMap((e) => mapper.push(e));
  return { out, outcome: mapper.outcome() };
};

describe("createTurnMapper", () => {
  it("maps streamed text to deltas then one complete progress", () => {
    const { out } = run([created("r1"), textDelta("he"), textDelta("llo"), message("hello")]);
    deepStrictEqual(out, [
      { type: "delta", text: "he" },
      { type: "delta", text: "llo" },
      { type: "progress", text: "hello" },
    ]);
  });

  it("marks a reasoning item as thinking", () => {
    const { out } = run([ev({ type: "response.output_item.added", item: { type: "reasoning" } })]);
    deepStrictEqual(out, [{ type: "status", text: "thinking" }]);
  });

  // Arguments are empty on .added, so the step (and its detail) waits.
  it("emits no step until the call's arguments are complete", () => {
    const { out } = run([callAdded("infino_sql")]);
    deepStrictEqual(out, [{ type: "status", text: "calling infino_sql" }]);
  });

  it("emits the step from the completed call, keyed by call_id", () => {
    const { out, outcome } = run([
      callAdded("infino_sql"),
      callDone("call_1", "infino_sql", '{"query":"SELECT 1"}'),
    ]);
    deepStrictEqual(out[1], {
      type: "step",
      id: "call_1",
      tool: "infino_sql",
      detail: "SELECT 1",
    });
    deepStrictEqual(outcome.calls, [
      { callId: "call_1", name: "infino_sql", args: '{"query":"SELECT 1"}' },
    ]);
  });

  it("titles a create_chart step with its chart type", () => {
    const { out } = run([
      callDone("c1", "create_chart", '{"title":"Denials","chart_type":"bar","sql":"SELECT 1"}'),
    ]);
    strictEqual((out[0] as { detail: string }).detail, "bar · Denials");
  });

  it("survives unparseable tool arguments", () => {
    const { out } = run([callDone("c1", "create_chart", "{not json")]);
    strictEqual((out[0] as { detail?: string }).detail, undefined);
  });

  it("records the response id and billed tokens on completion", () => {
    const { outcome } = run([created("r1"), completed("r1", 1861)]);
    strictEqual(outcome.status, "completed");
    strictEqual(outcome.responseId, "r1");
    strictEqual(outcome.totalTokens, 1861);
  });

  it("reports a content-filter stop as incomplete with its reason", () => {
    const { outcome } = run([
      ev({
        type: "response.incomplete",
        response: { id: "r1", incomplete_details: { reason: "content_filter" } },
      }),
    ]);
    strictEqual(outcome.status, "incomplete");
    strictEqual(outcome.stopReason, "content_filter");
  });

  it("reports a failed response with the provider's message", () => {
    const { outcome } = run([
      ev({ type: "response.failed", response: { id: "r1", error: { message: "boom" } } }),
    ]);
    strictEqual(outcome.status, "failed");
    strictEqual(outcome.stopReason, "boom");
  });

  // A truncated stream must never read as success.
  it("stays open when no terminal event arrives", () => {
    const { outcome } = run([created("r1"), textDelta("hi")]);
    strictEqual(outcome.status, "open");
  });

  it("ignores unknown events rather than failing the run", () => {
    const { out, outcome } = run([
      created("r1"),
      ev({ type: "response.azure_content_filter.whatever" }),
      completed("r1"),
    ]);
    deepStrictEqual(out, []);
    strictEqual(outcome.status, "completed");
  });

  it("drops an empty assistant message", () => {
    const { out } = run([message("   ")]);
    deepStrictEqual(out, []);
  });
});
