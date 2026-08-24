import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ChatEvent } from "@infino-ai/analytics-core";
import { runTurns, type LoopStats } from "../src/loop.js";
import type { ToolRegistry } from "../src/tools.js";

const ev = (e: unknown) => e as ResponseStreamEvent;

const answerTurn = (id: string, text: string, tokens = 10): ResponseStreamEvent[] => [
  ev({ type: "response.created", response: { id } }),
  ev({ type: "response.output_text.delta", delta: text }),
  ev({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text }] } }),
  ev({ type: "response.completed", response: { id, usage: { total_tokens: tokens } } }),
];

const callTurn = (id: string, callId: string, name: string, args = "{}", tokens = 10): ResponseStreamEvent[] => [
  ev({ type: "response.created", response: { id } }),
  ev({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: args } }),
  ev({ type: "response.completed", response: { id, usage: { total_tokens: tokens } } }),
];

function harness(turns: ResponseStreamEvent[][], registry?: Partial<ToolRegistry>) {
  const bodies: ResponseCreateParamsStreaming[] = [];
  const invoked: string[] = [];
  const pending: ChatEvent[] = [];
  const stats: LoopStats = { turns: 0, totalTokens: 0 };
  const tools: ToolRegistry = {
    definitions: [],
    async invoke(name) {
      invoked.push(name);
      return { text: "ok", isError: false };
    },
    ...registry,
  };
  const stream = async (body: ResponseCreateParamsStreaming) => {
    bodies.push(body);
    const events = turns[bodies.length - 1] ?? [];
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  const run = (over: Partial<Parameters<typeof runTurns>[0]> = {}) =>
    runTurns({
      question: "q",
      instructions: "be a good analyst",
      model: "gpt-5.4",
      maxTurns: 25,
      maxTotalTokens: 400_000,
      tools,
      stream,
      pending,
      stats,
      ...over,
    });
  return { run, bodies, invoked, pending, stats };
}

const collect = async (gen: AsyncGenerator<ChatEvent, { sessionId?: string }>) => {
  const events: ChatEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
};

describe("runTurns", () => {
  it("answers in one turn and returns the response id as the session", async () => {
    const h = harness([answerTurn("r1", "hi")]);
    const { events, result } = await collect(h.run());
    deepStrictEqual(events.map((e) => e.type), ["delta", "progress"]);
    strictEqual(result.sessionId, "r1");
    strictEqual(h.stats.turns, 1);
  });

  it("runs a tool then answers, pairing step with step_done", async () => {
    const h = harness([callTurn("r1", "c1", "infino_sql"), answerTurn("r2", "done")]);
    const { events, result } = await collect(h.run());
    deepStrictEqual(events.map((e) => e.type), ["step", "step_done", "delta", "progress"]);
    strictEqual((events[0] as { id: string }).id, "c1");
    strictEqual((events[1] as { id: string }).id, "c1");
    deepStrictEqual(h.invoked, ["infino_sql"]);
    strictEqual(result.sessionId, "r2");
  });

  // The resumption contract: only the new outputs go back, not the history.
  it("sends the question first, then only function_call_output", async () => {
    const h = harness([callTurn("r1", "c1", "infino_sql"), answerTurn("r2", "done")]);
    await collect(h.run());
    strictEqual(h.bodies[0].previous_response_id, undefined);
    deepStrictEqual(h.bodies[0].input, [{ role: "user", content: "q" }]);
    strictEqual(h.bodies[1].previous_response_id, "r1");
    deepStrictEqual(h.bodies[1].input, [
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
  });

  it("resends instructions every turn — they are not inherited", async () => {
    const h = harness([callTurn("r1", "c1", "infino_sql"), answerTurn("r2", "done")]);
    await collect(h.run());
    deepStrictEqual(
      h.bodies.map((b) => b.instructions),
      ["be a good analyst", "be a good analyst"],
    );
  });

  it("threads a resumed session into the first request", async () => {
    const h = harness([answerTurn("r9", "hi")]);
    await collect(h.run({ previousResponseId: "r-earlier" }));
    strictEqual(h.bodies[0].previous_response_id, "r-earlier");
  });

  // A mid-loop id points at a response with dangling calls.
  it("never returns a session id from a turn that called tools", async () => {
    const h = harness([
      callTurn("r1", "c1", "infino_sql"),
      callTurn("r2", "c2", "infino_count"),
      answerTurn("r3", "done"),
    ]);
    const { result } = await collect(h.run());
    strictEqual(result.sessionId, "r3");
    strictEqual(h.stats.turns, 3);
  });

  it("runs every call in a parallel-call turn and returns both outputs", async () => {
    const two: ResponseStreamEvent[] = [
      ev({ type: "response.created", response: { id: "r1" } }),
      ev({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "a", arguments: "{}" } }),
      ev({ type: "response.output_item.done", item: { type: "function_call", call_id: "c2", name: "b", arguments: "{}" } }),
      ev({ type: "response.completed", response: { id: "r1", usage: { total_tokens: 5 } } }),
    ];
    const h = harness([two, answerTurn("r2", "done")]);
    await collect(h.run());
    deepStrictEqual(h.invoked, ["a", "b"]);
    strictEqual((h.bodies[1].input as unknown[]).length, 2);
  });

  // Full chart rows reach the UI without ever entering model context.
  it("drains tool-pushed events between the step and its step_done", async () => {
    const h = harness([callTurn("r1", "c1", "create_chart"), answerTurn("r2", "done")], {
      async invoke() {
        h.pending.push({ type: "sql", query: "SELECT 1" });
        return { text: "receipt", isError: false };
      },
    });
    const { events } = await collect(h.run());
    deepStrictEqual(events.map((e) => e.type), ["step", "sql", "step_done", "delta", "progress"]);
    strictEqual((h.bodies[1].input as { output: string }[])[0].output, "receipt");
  });

  it("reports a failing tool on step_done without stopping the run", async () => {
    const h = harness([callTurn("r1", "c1", "infino_sql"), answerTurn("r2", "done")], {
      async invoke() {
        return { text: "query failed", isError: true };
      },
    });
    const { events } = await collect(h.run());
    strictEqual((events[1] as { ok: boolean }).ok, false);
  });

  it("accumulates billed tokens across turns", async () => {
    const h = harness([callTurn("r1", "c1", "a", "{}", 100), answerTurn("r2", "done", 250)]);
    await collect(h.run());
    strictEqual(h.stats.totalTokens, 350);
  });

  it("stops at the turn ceiling", async () => {
    const h = harness([callTurn("r1", "c1", "a"), callTurn("r2", "c2", "a"), callTurn("r3", "c3", "a")]);
    await rejects(() => collect(h.run({ maxTurns: 2 })), /agent stopped: max_turns/);
    strictEqual(h.bodies.length, 2);
  });

  it("stops at the token ceiling before starting another turn", async () => {
    const h = harness([callTurn("r1", "c1", "a", "{}", 60), callTurn("r2", "c2", "a", "{}", 60)]);
    await rejects(() => collect(h.run({ maxTotalTokens: 100 })), /agent stopped: max_tokens/);
    strictEqual(h.bodies.length, 2);
  });

  it("treats a content-filter stop as a stop, not an answer", async () => {
    const h = harness([
      [ev({ type: "response.incomplete", response: { id: "r1", incomplete_details: { reason: "content_filter" } } })],
    ]);
    await rejects(() => collect(h.run()), /agent stopped: content_filter/);
  });

  it("refuses to call a truncated stream a success", async () => {
    const h = harness([[ev({ type: "response.created", response: { id: "r1" } })]]);
    await rejects(() => collect(h.run()), /without a terminal event/);
  });

  it("propagates a transport failure for the caller to classify", async () => {
    const stats: LoopStats = { turns: 0, totalTokens: 0 };
    const gen = runTurns({
      question: "q",
      instructions: "i",
      model: "m",
      maxTurns: 5,
      maxTotalTokens: 1000,
      tools: { definitions: [], invoke: async () => ({ text: "", isError: false }) },
      stream: () => Promise.reject(new Error("socket hang up")),
      pending: [],
      stats,
    });
    await rejects(() => collect(gen), /socket hang up/);
  });

  it("omits reasoning unless an effort is configured", async () => {
    const h = harness([answerTurn("r1", "hi")]);
    await collect(h.run());
    ok(!("reasoning" in h.bodies[0]));
    const h2 = harness([answerTurn("r1", "hi")]);
    await collect(h2.run({ reasoningEffort: "low" }));
    match(JSON.stringify(h2.bodies[0].reasoning), /low/);
  });
});
