import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@opencode-ai/sdk/v2";
import type { ChatEvent } from "@infino-ai/analytics-core";
import { createOpencodeHarness, type OpencodeBackend } from "../src/index.js";

// The run controls the conformance suite does not reach: ceilings, resume,
// stalls, and abandonment. The backend is a live fake whose stream reacts to
// abort() the way opencode does, with an aborted-message error then idle.
const ev = (e: unknown) => e as Event;
const idle = (s: string) => ev({ type: "session.idle", properties: { sessionID: s } });
const aborted = (s: string) =>
  ev({ type: "session.error", properties: { sessionID: s, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
const cost = (s: string, usd: number) =>
  ev({ type: "message.updated", properties: { sessionID: s, info: { id: "msg_1", sessionID: s, role: "assistant", parentID: "msg_q", cost: usd } } });

interface FakeOptions {
  script: (session: string) => Event[];
  /** Keep the stream open after the script instead of ending it. */
  hang?: boolean;
  knownSessions?: string[];
  lookupFails?: boolean;
  /** How long the prompt request takes to land. */
  promptDelayMs?: number;
  /** A previous run is still finishing; it goes idle `settlesAfterAbort`. */
  busyBefore?: { settlesAfterAbort: boolean };
}

function fakeBackend(opts: FakeOptions) {
  const calls = { created: 0, prompted: [] as string[], aborted: [] as string[] };
  let push: ((e: Event) => void) | undefined;
  const backend: OpencodeBackend = {
    mcpServers: ["infino-engine", "fino"],
    createSession: async () => `ses_new_${++calls.created}`,
    isBusy: async () => !!opts.busyBefore && calls.prompted.length === 0,
    hasSession: async (id) => {
      if (opts.lookupFails) throw new Error("opencode unreachable");
      return (opts.knownSessions ?? []).includes(id);
    },
    prompt: async (id) => {
      if (opts.promptDelayMs) await new Promise((r) => setTimeout(r, opts.promptDelayMs));
      calls.prompted.push(id);
    },
    abort: async (id) => {
      calls.aborted.push(id);
      if (opts.busyBefore && calls.prompted.length === 0 && !opts.busyBefore.settlesAfterAbort) return;
      push?.(aborted(id));
      push?.(idle(id));
    },
    claimChart: () => [],
    subscribe: async (signal) => {
      const queue: Event[] = [];
      let wake: (() => void) | undefined;
      push = (e) => {
        queue.push(e);
        wake?.();
      };
      signal.addEventListener("abort", () => wake?.(), { once: true });
      return (async function* () {
        // The script starts once the prompt is in, as it does in opencode,
        // which first reports the session busy and records the question.
        // Events pushed before then (a previous run settling) come first.
        while (calls.prompted.length === 0) {
          if (signal.aborted) throw signal.reason;
          const early = queue.shift();
          if (early) yield early;
          else await new Promise((r) => setTimeout(r, 1));
        }
        const session = calls.prompted[calls.prompted.length - 1];
        queue.push(ev({ type: "session.status", properties: { sessionID: session, status: { type: "busy" } } }));
        queue.push(ev({ type: "message.updated", properties: { sessionID: session, info: { id: "msg_q", sessionID: session, role: "user" } } }));
        queue.push(...opts.script(session));
        for (;;) {
          if (signal.aborted) throw signal.reason;
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (!opts.hang && calls.aborted.length === (opts.busyBefore ? 1 : 0)) return;
          await new Promise<void>((r) => (wake = r));
        }
      })();
    },
  };
  return { backend, calls };
}

async function collect(gen: AsyncGenerator<ChatEvent, { sessionId?: string }>) {
  const events: ChatEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, returned: next.value };
    events.push(next.value);
  }
}

const harness = (backend: OpencodeBackend, extra: { maxBudgetUsd?: number; stallTimeoutMs?: number } = {}) =>
  createOpencodeHarness({ infino: { uri: "https://example.test/db", apiKey: "test" }, ...extra }, { backend });

const errors = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "error" ? [e.message] : []));

describe("opencode harness run controls", () => {
  it("stops a run over budget and says why", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [cost(s, 3)], hang: true });
    const { events } = await collect(harness(backend, { maxBudgetUsd: 2 })({ question: "q" }));
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
    ok(errors(events)[0]?.includes("budget of $2"));
    strictEqual(events.at(-1)?.type, "done");
  });

  it("stops a run that asks for permission instead of waiting on it", async () => {
    const { backend, calls } = fakeBackend({
      script: (s) => [ev({ type: "permission.asked", properties: { sessionID: s, id: "per_1" } })],
      hang: true,
    });
    const { events } = await collect(harness(backend)({ question: "q" }));
    strictEqual(calls.aborted.length, 1, "aborted exactly once");
    ok(errors(events)[0]?.includes("asked for input"));
  });

  it("resumes a session opencode still knows", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [idle(s)], knownSessions: ["ses_old"] });
    const { returned } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.prompted, ["ses_old"]);
    strictEqual(calls.created, 0);
    strictEqual(returned.sessionId, "ses_old");
  });

  it("starts over when the resumed session is gone", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [idle(s)] });
    const { events, returned } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_gone" }));
    deepStrictEqual(calls.prompted, ["ses_new_1"]);
    strictEqual(returned.sessionId, "ses_new_1");
    deepStrictEqual(errors(events), []);
  });

  it("reports a failed session lookup instead of silently starting over", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [idle(s)], lookupFails: true });
    const { events } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    strictEqual(calls.created, 0);
    ok(errors(events)[0]?.includes("opencode unreachable"));
  });

  it("stops a run that goes silent", async () => {
    const { backend, calls } = fakeBackend({ script: () => [], hang: true });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 20 })({ question: "q" }));
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
    ok(errors(events)[0]?.includes("no progress"));
    strictEqual(events.at(-1)?.type, "done");
  });

  it("does not let other sessions' events keep a stalled run alive", async () => {
    const { backend } = fakeBackend({ script: () => [cost("ses_other", 0)], hang: true });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 20 })({ question: "q" }));
    ok(errors(events)[0]?.includes("no progress"));
  });

  it("aborts the session when the consumer abandons the run", async () => {
    const thinking = (s: string) =>
      ev({ type: "message.part.updated", properties: { sessionID: s, part: { id: "p_r", sessionID: s, messageID: "m", type: "reasoning", text: "" } } });
    const { backend, calls } = fakeBackend({ script: (s) => [thinking(s)], hang: true });
    const gen = harness(backend)({ question: "q" });
    await gen.next();
    await gen.return({ sessionId: undefined });
    await new Promise((r) => setImmediate(r)); // the abort follows the landed prompt
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
  });

  it("aborts a prompt that was still landing when the run was cancelled", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [idle(s)], hang: true, promptDelayMs: 30 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const { events } = await collect(harness(backend)({ question: "q", signal: controller.signal }));
    deepStrictEqual(errors(events), [], "a cancellation is not an error");
    await new Promise((r) => setTimeout(r, 60));
    deepStrictEqual(calls.prompted, ["ses_new_1"]);
    deepStrictEqual(calls.aborted, ["ses_new_1"], "abort sent after the prompt landed");
  });

  it("does not count time the consumer spends holding an event as a stall", async () => {
    const thinking = (s: string) =>
      ev({ type: "message.part.updated", properties: { sessionID: s, part: { id: "p_r", sessionID: s, messageID: "m", type: "reasoning", text: "" } } });
    const { backend } = fakeBackend({ script: (s) => [thinking(s), idle(s)] });
    const gen = harness(backend, { stallTimeoutMs: 20 })({ question: "q" });
    const seen: ChatEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      seen.push(next.value);
      await new Promise((r) => setTimeout(r, 60)); // a slow reader
    }
    deepStrictEqual(errors(seen), []);
  });

  it("lets a previous run on the thread finish before prompting", async () => {
    const { backend, calls } = fakeBackend({
      script: (s) => [idle(s)],
      knownSessions: ["ses_old"],
      busyBefore: { settlesAfterAbort: true },
    });
    const { events } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.aborted, ["ses_old"], "the leftover run is stopped first");
    deepStrictEqual(calls.prompted, ["ses_old"]);
    deepStrictEqual(errors(events), []);
  });

  it("refuses to prompt over a previous run that will not settle", async () => {
    const { backend, calls } = fakeBackend({
      script: (s) => [idle(s)],
      knownSessions: ["ses_old"],
      busyBefore: { settlesAfterAbort: false },
    });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 20 })({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.prompted, []);
    ok(errors(events)[0]?.includes("still finishing"));
  });

  it("does not abort a session that finished", async () => {
    const { backend, calls } = fakeBackend({ script: (s) => [idle(s)] });
    await collect(harness(backend)({ question: "q" }));
    deepStrictEqual(calls.aborted, []);
  });

  it("rejects a model id without a provider at construction", () => {
    throws(
      () => createOpencodeHarness({ infino: { uri: "https://example.test/db", apiKey: "t" }, model: "gemini-3.5-flash" }),
      /<provider>\/<model>/,
    );
  });
});
