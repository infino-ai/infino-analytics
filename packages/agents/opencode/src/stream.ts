import type { Event } from "@opencode-ai/sdk/v2";
import { stepDetail, stepResult, type ChatEvent } from "@infino-ai/analytics-core";

// opencode event stream → ChatEvent. Pure and synchronous: one event in, zero
// or more out, no I/O. The harness owns the subscription and the session
// calls, which is what makes this mapping testable without a server.

export interface RunOutcome {
  /** The run is over: the session went idle after this run's question, or
   * failed before ever taking it. */
  ended: boolean;
  /** Set when the run failed, including a cancellation this run did not ask
   * for. */
  failure?: string;
  /** opencode stopped to ask for a permission or an answer. Nobody is there
   * to give one, so the harness aborts instead of waiting forever. */
  blocked?: string;
  costUsd: number;
  turns: number;
}

export interface EventMapper {
  push(event: Event): ChatEvent[];
  outcome(): RunOutcome;
}

export interface MapperOptions {
  sessionId: string;
  /** The id this run sent its question under. */
  questionId: string;
  /** MCP server names as configured; opencode prefixes tool ids with them. */
  mcpServers: readonly string[];
  /** Returns the UI events a create_chart call parked, given its output. */
  claimChart(output: string | undefined): ChatEvent[];
  /** Whether this run asked opencode to cancel, so an abort it did not ask
   * for reads as a failure rather than a quiet, empty answer. */
  abortedByRun(): boolean;
}

export function createEventMapper(opts: MapperOptions): EventMapper {
  // The run's own messages. Its question, plus any user message opencode adds
  // after it (compaction's continue prompt); a previous run on the session
  // can still be emitting late updates for messages from before it.
  let asked = false;
  const questions = new Set<string>();
  const answers = new Set<string>();
  const costByMessage = new Map<string, number>();
  let busy = false;

  const partTypes = new Map<string, string>();
  const progressed = new Set<string>();
  const opened = new Set<string>();
  const closed = new Set<string>();
  const outcome: RunOutcome = { ended: false, costUsd: 0, turns: 0 };

  const toolName = (id: string) => {
    const server = opts.mcpServers.find((s) => id.startsWith(`${s}_`));
    return server ? id.slice(server.length + 1) : id;
  };

  return {
    push(event) {
      if (sessionOf(event) !== opts.sessionId) return [];

      switch (event.type) {
        case "message.updated": {
          const info = event.properties.info;
          if (info.role === "user") {
            if (info.id === opts.questionId) asked = true;
            if (asked) questions.add(info.id);
          } else if (questions.has(info.parentID)) {
            costByMessage.set(info.id, info.cost ?? 0);
            outcome.turns = costByMessage.size;
            outcome.costUsd = [...costByMessage.values()].reduce((a, b) => a + b, 0);
            // A compaction summary is opencode's note to itself: it costs
            // money but is no part of the answer.
            if (!info.summary) answers.add(info.id);
          }
          return [];
        }

        case "message.part.updated": {
          const part = event.properties.part;
          if (!answers.has(part.messageID)) return [];
          const seen = partTypes.has(part.id);
          partTypes.set(part.id, part.type);

          if (part.type === "reasoning" && !seen) return [{ type: "status", text: "thinking" }];

          if (part.type === "text") {
            // A text part is re-sent as it grows; it is final once it has an
            // end time, and only then becomes a durable progress event.
            if (!part.time?.end || progressed.has(part.id) || part.synthetic || !part.text.trim()) return [];
            progressed.add(part.id);
            return [{ type: "progress", text: part.text }];
          }

          if (part.type !== "tool") return [];
          const out: ChatEvent[] = [];
          const { state } = part;
          const name = toolName(part.tool);
          // Input is empty while pending; running is the first state with it.
          if (state.status !== "pending" && !opened.has(part.callID)) {
            opened.add(part.callID);
            out.push({ type: "step", id: part.callID, tool: name, detail: stepDetail(state.input) });
          }
          if ((state.status === "completed" || state.status === "error") && !closed.has(part.callID)) {
            closed.add(part.callID);
            const output = state.status === "completed" ? state.output : state.error;
            if (name === "create_chart") out.push(...opts.claimChart(output));
            out.push({ type: "step_done", id: part.callID, ok: state.status === "completed", result: stepResult(output) });
          }
          return out;
        }

        case "message.part.delta": {
          const { messageID, partID, field, delta } = event.properties;
          const isAnswer = field === "text" && answers.has(messageID) && partTypes.get(partID) === "text";
          return isAnswer && delta ? [{ type: "delta", text: delta }] : [];
        }

        case "session.error": {
          const error = event.properties.error;
          if (!error) return [];
          // opencode compacts the conversation and carries on.
          if (error.name === "ContextOverflowError") return [];
          if (error.name === "MessageAbortedError") {
            if (asked && !opts.abortedByRun()) outcome.failure ??= "agent stopped: the answer was cancelled";
            return [];
          }
          const message = "data" in error && error.data && typeof error.data.message === "string" ? error.data.message : "";
          outcome.failure ??= `agent stopped: ${error.name}${message ? ` — ${message.slice(0, 300)}` : ""}`;
          // Failing before it ever went busy (the provider rejected the
          // request outright), opencode sends no busy or idle to wait for.
          if (!busy) outcome.ended = true;
          return [];
        }

        case "permission.asked":
        case "permission.v2.asked":
        case "question.asked":
        case "question.v2.asked":
          outcome.blocked ??= `agent stopped: opencode asked for input (${event.type})`;
          return [];

        case "session.status": {
          const status = event.properties.status;
          busy = status.type !== "idle";
          // A provider retry can take a while; say so instead of going quiet.
          return status.type === "retry" ? [{ type: "status", text: `retrying: ${status.message}` }] : [];
        }

        case "session.idle":
          // An idle before this run's question is a previous run's.
          busy = false;
          if (asked) outcome.ended = true;
          return [];

        default:
          return [];
      }
    },
    outcome: () => outcome,
  };
}

/** The session an event belongs to; undefined for server-wide events. */
export function sessionOf(event: Event): string | undefined {
  const props = (event as { properties?: { sessionID?: unknown } }).properties;
  return typeof props?.sessionID === "string" ? props.sessionID : undefined;
}
