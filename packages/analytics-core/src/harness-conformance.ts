import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "./events.js";
import type { AgentHarness } from "./harness.js";

// The harness contract, as an executable spec. Every rule here is behavioural
// — two harnesses satisfy them with structurally different code — so a shared
// base class could not enforce any of it, and a shared test can enforce all of
// it. A new harness is correct when this passes.
//
// The kit owns the assertions; each harness supplies the fixtures, because
// only it knows its provider's wire format.

export interface ConformanceScenarios {
  /** Provider streams text and completes. No tools. */
  answersText(): AgentHarness;
  /** Provider calls exactly one tool, then answers. */
  callsTool(): AgentHarness;
  /** Provider fails part-way through the run. */
  providerFails(): AgentHarness;
}

interface Run {
  events: ChatEvent[];
  returned: { sessionId?: string };
}

async function run(harness: AgentHarness, signal?: AbortSignal): Promise<Run> {
  const gen = harness({ question: "how many rows?", signal });
  const events: ChatEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, returned: next.value ?? {} };
    events.push(next.value);
  }
}

const only = <T extends ChatEvent["type"]>(events: ChatEvent[], type: T) =>
  events.filter((e) => e.type === type) as Extract<ChatEvent, { type: T }>[];

/** Assert a harness honours the ChatEvent contract. Call from the harness
 * package's own test file. */
export function assertHarnessConformance(name: string, scenarios: ConformanceScenarios): void {
  describe(`${name} harness conformance`, () => {
    it("ends with exactly one done, and yields nothing after it", async () => {
      for (const [label, make] of Object.entries(scenarios)) {
        const { events } = await run(make());
        strictEqual(only(events, "done").length, 1, `${label}: expected exactly one done`);
        strictEqual(events[events.length - 1]?.type, "done", `${label}: done must be last`);
      }
    });

    it("reports a provider failure as error then done, in that order", async () => {
      const { events } = await run(scenarios.providerFails());
      const errorAt = events.findIndex((e) => e.type === "error");
      const doneAt = events.findIndex((e) => e.type === "done");
      ok(errorAt !== -1, "a provider failure must surface an error event");
      ok(errorAt < doneAt, "error must precede done, or a consumer never sees it");
    });

    // Cancellation is a normal outcome. An error here puts a red banner in
    // front of a user who simply clicked stop.
    it("treats abort as done, never as an error", async () => {
      for (const [label, make] of Object.entries(scenarios)) {
        if (label === "providerFails") continue;
        const controller = new AbortController();
        controller.abort();
        const { events } = await run(make(), controller.signal);
        deepStrictEqual(only(events, "error"), [], `${label}: abort must not emit error`);
        strictEqual(only(events, "done").length, 1, `${label}: abort must still emit done`);
      }
    });

    it("closes every step it opens", async () => {
      const { events } = await run(scenarios.callsTool());
      const opened = only(events, "step").map((e) => e.id);
      const closed = only(events, "step_done").map((e) => e.id);
      ok(opened.length > 0, "the callsTool scenario must emit at least one step");
      deepStrictEqual(
        [...opened].sort(),
        [...closed].sort(),
        "an unclosed step leaves a spinner running in the trace UI",
      );
    });

    it("opens a step before closing it", async () => {
      const { events } = await run(scenarios.callsTool());
      for (const [i, event] of events.entries()) {
        if (event.type !== "step_done") continue;
        const openedAt = events.findIndex((e) => e.type === "step" && e.id === event.id);
        ok(openedAt !== -1 && openedAt < i, `step_done ${event.id} arrived before its step`);
      }
    });

    it("agrees with itself about the session id", async () => {
      const { events, returned } = await run(scenarios.answersText());
      const done = only(events, "done")[0];
      // The facade reads both the done event and the generator's return value.
      const fromDone = done.sessionId === "" ? undefined : done.sessionId;
      strictEqual(returned.sessionId, fromDone, "done.sessionId and the return value disagree");
    });

    it("supersedes transient events with a durable one", async () => {
      const { events } = await run(scenarios.answersText());
      const lastTransient = events.map((e) => e.type).lastIndexOf("delta");
      const lastDurable = Math.max(
        events.map((e) => e.type).lastIndexOf("progress"),
        events.map((e) => e.type).lastIndexOf("summary"),
      );
      if (lastTransient === -1) return; // streaming deltas are optional
      ok(lastDurable > lastTransient, "streamed deltas must be superseded by progress/summary");
    });

    it("emits a done even when the provider produced nothing useful", async () => {
      const { events } = await run(scenarios.providerFails());
      strictEqual(only(events, "done").length, 1);
    });
  });
}
