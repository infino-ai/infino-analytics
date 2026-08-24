import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentHarness, ChatEvent, StoredMessage } from "@infino-ai/analytics-core";
import { Analytics } from "../src/index.js";

/** A harness is just a generator of ChatEvents — no LLM, no network. That is
 * the whole contract, and this file is its executable statement. */
function fakeHarness(
  events: ChatEvent[],
  opts: { sessionId?: string; seen?: { resumeSessionId?: string }[]; onReturn?: () => void } = {},
): AgentHarness {
  return async function* (params) {
    opts.seen?.push({ resumeSessionId: params.resumeSessionId });
    try {
      for (const event of events) yield event;
    } finally {
      opts.onReturn?.();
    }
    return { sessionId: opts.sessionId };
  };
}

const analytics = (harness: AgentHarness) =>
  new Analytics({ infino: { uri: "https://example.test/db", apiKey: "test" }, harness });

const drain = async (gen: AsyncGenerator<ChatEvent>) => {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const assistantEvents = (messages: StoredMessage[]) =>
  messages.flatMap((m) => (m.role === "assistant" ? m.events : []));

describe("Analytics config", () => {
  it("accepts a harness alone", () => {
    analytics(fakeHarness([]));
  });

  it("accepts llm alone", () => {
    new Analytics({ infino: { uri: "https://example.test/db", apiKey: "test" }, llm: { model: "x" } });
  });

  // Silently ignoring one of them is how a deployment runs the wrong model.
  it("refuses both llm and harness", () => {
    throws(
      () =>
        new Analytics({
          infino: { uri: "https://example.test/db", apiKey: "test" },
          llm: { model: "x" },
          harness: fakeHarness([]),
        }),
      /either llm .* or harness .* not both/,
    );
  });
});

describe("Analytics.ask", () => {
  it("yields every harness event in order", async () => {
    const events: ChatEvent[] = [
      { type: "status", text: "thinking" },
      { type: "delta", text: "he" },
      { type: "progress", text: "hello" },
      { type: "done", sessionId: "s1" },
    ];
    const seen = await drain(analytics(fakeHarness(events)).ask("q"));
    deepStrictEqual(seen, events);
  });

  it("runs one-shot without a threadId, leaving no trace", async () => {
    const a = analytics(fakeHarness([{ type: "done", sessionId: "s1" }]));
    await drain(a.ask("q"));
    deepStrictEqual(await a.threads.list(), []);
  });

  it("persists the question and only the durable events", async () => {
    const a = analytics(
      fakeHarness([
        { type: "status", text: "thinking" },
        { type: "delta", text: "he" },
        { type: "progress", text: "hello" },
        { type: "done", sessionId: "s1" },
      ]),
    );
    const thread = await a.threads.create();
    await drain(a.ask("why the denials?", { threadId: thread.id }));

    const messages = await a.threads.listMessages(thread.id);
    strictEqual(messages.length, 2);
    ok(messages[0].role === "user" && messages[0].text === "why the denials?");
    // status and delta are transient by contract.
    deepStrictEqual(
      assistantEvents(messages).map((e) => e.type),
      ["progress", "done"],
    );
  });

  it("titles a new thread from its first question", async () => {
    const a = analytics(fakeHarness([{ type: "done", sessionId: "s1" }]));
    const thread = await a.threads.create();
    await drain(a.ask("why the denials?", { threadId: thread.id }));
    strictEqual((await a.threads.get(thread.id))?.title, "why the denials?");
  });

  it("stores the harness session pointer and replays it on the next turn", async () => {
    const seen: { resumeSessionId?: string }[] = [];
    const a = analytics(fakeHarness([{ type: "done", sessionId: "s1" }], { sessionId: "s1", seen }));
    const thread = await a.threads.create();

    await drain(a.ask("first", { threadId: thread.id }));
    strictEqual((await a.threads.get(thread.id))?.agentSessionId, "s1");

    await drain(a.ask("second", { threadId: thread.id }));
    deepStrictEqual(seen, [{ resumeSessionId: undefined }, { resumeSessionId: "s1" }]);
  });

  it("takes the session id from the generator's return value", async () => {
    // A harness may return the pointer without ever emitting it on `done`.
    const a = analytics(fakeHarness([{ type: "progress", text: "hi" }], { sessionId: "from-return" }));
    const thread = await a.threads.create();
    await drain(a.ask("q", { threadId: thread.id }));
    strictEqual((await a.threads.get(thread.id))?.agentSessionId, "from-return");
  });

  it("persists the partial turn when the consumer breaks mid-stream", async () => {
    const a = analytics(
      fakeHarness([
        { type: "progress", text: "first" },
        { type: "progress", text: "second" },
        { type: "done", sessionId: "s1" },
      ]),
    );
    const thread = await a.threads.create();
    for await (const event of a.ask("q", { threadId: thread.id })) {
      if (event.type === "progress") break;
    }
    deepStrictEqual(
      assistantEvents(await a.threads.listMessages(thread.id)).map((e) => e.type),
      ["progress"],
    );
  });

  // The leak: an abandoned ask() must still run the harness's own cleanup.
  it("closes the harness generator when the consumer breaks", async () => {
    let closed = false;
    const a = analytics(
      fakeHarness([{ type: "progress", text: "x" }, { type: "done", sessionId: "s1" }], {
        onReturn: () => {
          closed = true;
        },
      }),
    );
    const thread = await a.threads.create();
    for await (const _ of a.ask("q", { threadId: thread.id })) break;
    strictEqual(closed, true);
  });

  it("writes nothing when the turn produced no durable events", async () => {
    const a = analytics(fakeHarness([{ type: "status", text: "thinking" }]));
    const thread = await a.threads.create();
    await drain(a.ask("q", { threadId: thread.id }));
    deepStrictEqual(assistantEvents(await a.threads.listMessages(thread.id)), []);
  });

  it("rejects an unknown thread", async () => {
    const a = analytics(fakeHarness([]));
    await rejects(() => drain(a.ask("q", { threadId: "nope" })), /unknown thread: nope/);
  });
});
