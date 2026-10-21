import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@opencode-ai/sdk/v2";
import type { ChatEvent } from "@infino-ai/analytics-core";
import { createOpencodeHarness, newMessageId, type OpencodeBackend, type OpencodeSeams } from "../src/index.js";
import type { OpencodeServer } from "../src/server.js";

// The run controls the conformance suite does not reach: ceilings, resume,
// stalls, cancellation, abandonment, and the server's lifecycle. The backend
// is a live fake whose stream reacts to abort() the way opencode does, with
// an aborted-message error then idle, sent to every open subscription.
const ev = (e: unknown) => e as Event;
const idle = (s: string) => ev({ type: "session.idle", properties: { sessionID: s } });
const busy = (s: string) => ev({ type: "session.status", properties: { sessionID: s, status: { type: "busy" } } });
const aborted = (s: string) =>
  ev({ type: "session.error", properties: { sessionID: s, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
const question = (s: string, q: string) => ev({ type: "message.updated", properties: { sessionID: s, info: { id: q, sessionID: s, role: "user" } } });
const reply = (s: string, q: string, cost = 0) =>
  ev({ type: "message.updated", properties: { sessionID: s, info: { id: "msg_reply", sessionID: s, role: "assistant", parentID: q, cost } } });
const text = (s: string, value: string) =>
  ev({
    type: "message.part.updated",
    properties: { sessionID: s, part: { id: "p_text", sessionID: s, messageID: "msg_reply", type: "text", text: value, time: { start: 1, end: 2 } } },
  });
const thinking = (s: string) =>
  ev({ type: "message.part.updated", properties: { sessionID: s, part: { id: "p_r", sessionID: s, messageID: "msg_reply", type: "reasoning", text: "" } } });
/** What opencode sends as it takes a question: busy, then the question. */
const opened = (s: string, q: string) => [busy(s), question(s, q), reply(s, q)];
const answered = (s: string, q: string, value = "ok") => [...opened(s, q), text(s, value), idle(s)];

interface FakeOptions {
  /** The run's events, once its prompt has landed. */
  script: (session: string, questionId: string) => Event[];
  /** Delay before each scripted event. */
  gapMs?: number;
  /** Keep the stream open after the script instead of ending it. */
  hang?: boolean;
  /** Events from another session, every `everyMs` for `forMs`. */
  foreign?: { everyMs: number; forMs: number };
  knownSessions?: string[];
  lookupFails?: boolean;
  /** How long each prompt request takes to land, by call. */
  promptDelaysMs?: number[];
  /** A previous run is still finishing; it goes idle after an abort only if
   * `settlesAfterAbort`. */
  busyBefore?: { settlesAfterAbort: boolean };
  /** Whether abort() is followed by opencode's error and idle (default yes). */
  confirmsAbort?: boolean;
}

function fakeBackend(opts: FakeOptions) {
  const calls = { created: 0, prompted: [] as { session: string; id: string }[], aborted: [] as string[], log: [] as string[] };
  const subscribers = new Set<(e: Event) => void>();
  const broadcast = (e: Event) => subscribers.forEach((push) => push(e));
  let busyLeft = !!opts.busyBefore;
  let promptsSent = 0;

  const backend: OpencodeBackend = {
    mcpServers: ["infino-engine", "fino"],
    createSession: async () => `ses_new_${++calls.created}`,
    hasSession: async (id) => {
      if (opts.lookupFails) throw new Error("opencode unreachable");
      return (opts.knownSessions ?? []).includes(id) || id.startsWith("ses_new_");
    },
    isBusy: async () => busyLeft,
    prompt: async (session, _text, id) => {
      calls.log.push("prompt:sent");
      const delay = opts.promptDelaysMs?.[promptsSent++] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      calls.prompted.push({ session, id });
      calls.log.push("prompt:landed");
    },
    abort: async (id) => {
      calls.aborted.push(id);
      calls.log.push("abort");
      if (busyLeft) {
        if (!opts.busyBefore?.settlesAfterAbort) return;
        busyLeft = false;
      } else if (opts.confirmsAbort === false) {
        return;
      }
      broadcast(aborted(id));
      broadcast(idle(id));
    },
    claimChart: () => [],
    subscribe: async (signal) => {
      const queue: Event[] = [];
      let wake: (() => void) | undefined;
      const push = (e: Event) => {
        queue.push(e);
        wake?.();
      };
      subscribers.add(push);
      signal.addEventListener("abort", () => wake?.(), { once: true });
      const promptsBefore = calls.prompted.length;
      let foreignDone = !opts.foreign;
      if (opts.foreign) {
        const { everyMs, forMs } = opts.foreign;
        const timer = setInterval(() => push(busy("ses_other")), everyMs);
        setTimeout(() => {
          clearInterval(timer);
          foreignDone = true;
          wake?.();
        }, forMs);
      }
      const next = async () => {
        while (queue.length === 0) {
          if (signal.aborted) throw signal.reason;
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 5);
          });
        }
        return queue.shift() as Event;
      };
      return (async function* () {
        try {
          // A previous run settling comes first; this run's script starts once
          // its own prompt has landed, as in opencode.
          while (calls.prompted.length === promptsBefore) {
            if (signal.aborted) throw signal.reason;
            if (queue.length) yield queue.shift() as Event;
            else await new Promise((r) => setTimeout(r, 1));
          }
          const { session, id } = calls.prompted[calls.prompted.length - 1];
          for (const e of opts.script(session, id)) {
            if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
            push(e);
            yield await next();
          }
          for (;;) {
            if (!opts.hang && foreignDone && queue.length === 0) return;
            if (queue.length === 0 && !opts.hang && !foreignDone) {
              await new Promise((r) => setTimeout(r, 1));
              continue;
            }
            yield await next();
          }
        } finally {
          subscribers.delete(push);
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

const INFINO = { uri: "https://example.test/db", apiKey: "test" };
const harness = (backend: OpencodeBackend, extra: { maxBudgetUsd?: number; stallTimeoutMs?: number } = {}, seams: OpencodeSeams = {}) =>
  createOpencodeHarness({ infino: INFINO, ...extra }, { backend, ...seams });

const errors = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "error" ? [e.message] : []));
const done = (events: ChatEvent[]) => events.find((e) => e.type === "done") as Extract<ChatEvent, { type: "done" }>;
const progress = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "progress" ? [e.text] : []));

describe("opencode harness run controls", () => {
  it("stops a run over budget, says why once, and reports what it spent", async () => {
    const { backend, calls } = fakeBackend({ script: (s, q) => [...opened(s, q), reply(s, q, 3)], hang: true });
    const { events } = await collect(harness(backend, { maxBudgetUsd: 2 })({ question: "q" }));
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
    deepStrictEqual(errors(events), ["agent stopped: budget of $2 exceeded"]);
    deepStrictEqual({ turns: done(events).turns, costUsd: done(events).costUsd }, { turns: 1, costUsd: 3 });
    strictEqual(events.at(-1)?.type, "done");
  });

  it("stops a run that asks for permission instead of waiting on it", async () => {
    const { backend, calls } = fakeBackend({
      script: (s, q) => [...opened(s, q), ev({ type: "permission.asked", properties: { sessionID: s, id: "per_1" } })],
      hang: true,
    });
    const { events } = await collect(harness(backend)({ question: "q" }));
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
    deepStrictEqual(errors(events), ["agent stopped: opencode asked for input (permission.asked)"]);
  });

  it("gives a stopped run only a short grace to wind down", async () => {
    const { backend } = fakeBackend({ script: (s, q) => [...opened(s, q), reply(s, q, 3)], hang: true, confirmsAbort: false });
    const started = Date.now();
    const { events } = await collect(harness(backend, { maxBudgetUsd: 2, stallTimeoutMs: 10_000 }, { stopGraceMs: 30 })({ question: "q" }));
    deepStrictEqual(errors(events), ["agent stopped: budget of $2 exceeded"]);
    ok(Date.now() - started < 2000, "ended on the grace, not the stall timeout");
  });

  it("resumes a session opencode still knows", async () => {
    const { backend, calls } = fakeBackend({ script: answered, knownSessions: ["ses_old"] });
    const { events, returned } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.prompted.map((p) => p.session), ["ses_old"]);
    strictEqual(calls.created, 0);
    strictEqual(returned.sessionId, "ses_old");
    deepStrictEqual(progress(events), ["ok"]);
  });

  it("starts over when the resumed session is gone", async () => {
    const { backend, calls } = fakeBackend({ script: answered });
    const { events, returned } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_gone" }));
    deepStrictEqual(calls.prompted.map((p) => p.session), ["ses_new_1"]);
    strictEqual(returned.sessionId, "ses_new_1");
    deepStrictEqual(errors(events), []);
  });

  it("reports a failed session lookup instead of silently starting over", async () => {
    const { backend, calls } = fakeBackend({ script: answered, lookupFails: true });
    const { events } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    strictEqual(calls.created, 0);
    deepStrictEqual(errors(events), ["opencode unreachable"]);
  });

  it("stops a run that goes silent", async () => {
    const { backend, calls } = fakeBackend({ script: () => [], hang: true });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 20 })({ question: "q" }));
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
    deepStrictEqual(errors(events), ["agent stopped: no progress from opencode in 0 s"]);
  });

  it("does not let other sessions' events keep a stalled run alive", async () => {
    const { backend } = fakeBackend({ script: () => [], foreign: { everyMs: 5, forMs: 300 } });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 40 })({ question: "q" }));
    deepStrictEqual(errors(events), ["agent stopped: no progress from opencode in 0 s"]);
  });

  it("does not count time the consumer spends holding an event as a stall", async () => {
    const { backend } = fakeBackend({ script: (s, q) => [...opened(s, q), thinking(s), text(s, "ok"), idle(s)], gapMs: 10 });
    const gen = harness(backend, { stallTimeoutMs: 40 })({ question: "q" });
    const seen: ChatEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      seen.push(next.value);
      await new Promise((r) => setTimeout(r, 80)); // a slow reader
    }
    deepStrictEqual(errors(seen), []);
    deepStrictEqual(progress(seen), ["ok"]);
  });

  it("ends at once with opencode's error when it fails before going busy", async () => {
    const { backend } = fakeBackend({
      script: (s) => [ev({ type: "session.error", properties: { sessionID: s, error: { name: "ProviderAuthError", data: { message: "bad key" } } } })],
      hang: true,
    });
    const started = Date.now();
    const { events } = await collect(harness(backend, { stallTimeoutMs: 10_000 })({ question: "q" }));
    deepStrictEqual(errors(events), ["agent stopped: ProviderAuthError — bad key"]);
    ok(Date.now() - started < 2000);
  });

  it("reports opencode's own error, not a stall, when it fails and then goes quiet", async () => {
    const { backend } = fakeBackend({
      script: (s, q) => [...opened(s, q), ev({ type: "session.error", properties: { sessionID: s, error: { name: "ApiError", data: { message: "quota" } } } })],
      hang: true,
    });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 30 })({ question: "q" }));
    deepStrictEqual(errors(events), ["agent stopped: ApiError — quota"]);
  });

  it("says so when the event stream ends before the run does", async () => {
    const { backend } = fakeBackend({ script: opened });
    const { events } = await collect(harness(backend)({ question: "q" }));
    deepStrictEqual(errors(events), ["agent stopped: opencode event stream ended mid-run"]);
  });

  it("aborts the session when the consumer abandons the run", async () => {
    const { backend, calls } = fakeBackend({ script: (s, q) => [...opened(s, q), thinking(s)], hang: true });
    const gen = harness(backend)({ question: "q" });
    await gen.next();
    await gen.return({ sessionId: undefined });
    await new Promise((r) => setImmediate(r)); // the abort follows the landed prompt
    deepStrictEqual(calls.aborted, ["ses_new_1"]);
  });

  it("sends a cancellation only after the prompt it cancels has landed", async () => {
    const { backend, calls } = fakeBackend({ script: answered, hang: true, promptDelaysMs: [30] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const { events } = await collect(harness(backend)({ question: "q", signal: controller.signal }));
    deepStrictEqual(errors(events), [], "a cancellation is not an error");
    await new Promise((r) => setTimeout(r, 60));
    deepStrictEqual(calls.log, ["prompt:sent", "prompt:landed", "abort"]);
  });

  it("keeps a cancelled run's late abort off the next question on the thread", async () => {
    const { backend, calls } = fakeBackend({ script: answered, promptDelaysMs: [40, 0] });
    const run = harness(backend);
    const controller = new AbortController();
    const first = collect(run({ question: "first", signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    await first;
    const { events } = await collect(run({ question: "second", resumeSessionId: "ses_new_1" }));
    deepStrictEqual(errors(events), []);
    deepStrictEqual(progress(events), ["ok"]);
    deepStrictEqual(calls.log, ["prompt:sent", "prompt:landed", "abort", "prompt:sent", "prompt:landed"]);
  });

  it("touches nothing when the run is cancelled before it starts", async () => {
    const { backend, calls } = fakeBackend({ script: answered });
    const controller = new AbortController();
    controller.abort();
    const { events } = await collect(harness(backend)({ question: "q", signal: controller.signal }));
    deepStrictEqual({ created: calls.created, log: calls.log }, { created: 0, log: [] });
    deepStrictEqual(events, [{ type: "done", sessionId: "", turns: undefined, costUsd: undefined }]);
  });

  it("lets a previous run on the thread finish before prompting", async () => {
    const { backend, calls } = fakeBackend({ script: answered, knownSessions: ["ses_old"], busyBefore: { settlesAfterAbort: true } });
    const { events } = await collect(harness(backend)({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.log, ["abort", "prompt:sent", "prompt:landed"]);
    deepStrictEqual(errors(events), []);
    deepStrictEqual(progress(events), ["ok"]);
  });

  it("refuses to prompt over a previous run that will not settle", async () => {
    const { backend, calls } = fakeBackend({ script: answered, knownSessions: ["ses_old"], busyBefore: { settlesAfterAbort: false } });
    const { events } = await collect(harness(backend, { stallTimeoutMs: 20 })({ question: "q", resumeSessionId: "ses_old" }));
    deepStrictEqual(calls.prompted, []);
    deepStrictEqual(errors(events), ["agent stopped: the previous answer on this thread is still finishing; ask again in a moment"]);
  });

  it("does not abort a session that finished", async () => {
    const { backend, calls } = fakeBackend({ script: answered });
    await collect(harness(backend)({ question: "q" }));
    await new Promise((r) => setImmediate(r));
    deepStrictEqual(calls.aborted, []);
  });
});

describe("opencode server lifecycle", () => {
  const fakeServer = (backend: OpencodeBackend) => {
    let alive = true;
    let closed = 0;
    const server: OpencodeServer = {
      backend,
      alive: () => alive,
      close: async () => {
        closed++;
      },
    };
    return { server, kill: () => (alive = false), closed: () => closed };
  };
  const lifecycle = (start: NonNullable<OpencodeSeams["start"]>) =>
    createOpencodeHarness({ infino: INFINO, model: "fake/model" }, { start });

  it("boots once for concurrent runs", async () => {
    let starts = 0;
    const run = lifecycle(async () => {
      starts++;
      await new Promise((r) => setTimeout(r, 20));
      return fakeServer(fakeBackend({ script: answered }).backend).server;
    });
    await Promise.all([collect(run({ question: "a" })), collect(run({ question: "b" }))]);
    strictEqual(starts, 1);
  });

  it("does not cache a failed boot", async () => {
    let starts = 0;
    const run = lifecycle(async () => {
      if (++starts === 1) throw new Error("no working opencode binary");
      return fakeServer(fakeBackend({ script: answered }).backend).server;
    });
    deepStrictEqual(errors((await collect(run({ question: "a" }))).events), ["no working opencode binary"]);
    deepStrictEqual(errors((await collect(run({ question: "b" }))).events), []);
    strictEqual(starts, 2);
  });

  it("replaces a server that died, and closes the dead one", async () => {
    const booted: ReturnType<typeof fakeServer>[] = [];
    const run = lifecycle(async () => {
      const s = fakeServer(fakeBackend({ script: answered }).backend);
      booted.push(s);
      return s.server;
    });
    await collect(run({ question: "a" }));
    booted[0].kill();
    deepStrictEqual(errors((await collect(run({ question: "b" }))).events), []);
    deepStrictEqual({ boots: booted.length, closed: booted[0].closed() }, { boots: 2, closed: 1 });
  });
});

describe("opencode harness config", () => {
  it("rejects a model id without a provider", () => {
    throws(() => createOpencodeHarness({ infino: INFINO, model: "gemini-3.5-flash" }), /<provider>\/<model>/);
  });

  it("rejects a turn ceiling that is not a whole number", () => {
    throws(() => createOpencodeHarness({ infino: INFINO, model: "a/b", maxTurns: 2.5 }), /maxTurns must be a whole number/);
  });

  it("rejects a tool timeout too long for a timer", () => {
    throws(() => createOpencodeHarness({ infino: INFINO, model: "a/b", mcpTimeoutMs: 1e12 }), /mcpTimeoutMs must be a whole number/);
  });
});

describe("message ids", () => {
  it("follow opencode's format and sort in creation order", () => {
    const ids = [newMessageId(1_760_000_000_000), newMessageId(1_760_000_000_000), newMessageId(1_760_000_000_001)];
    for (const id of ids) match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    deepStrictEqual([...ids].sort(), ids);
  });
});
