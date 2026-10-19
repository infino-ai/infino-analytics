import type { Event } from "@opencode-ai/sdk/v2";
import { stepDetail, stepResult, type ChatEvent } from "@infino-ai/analytics-core";

// opencode event stream → ChatEvent. Pure and synchronous: one event in, zero
// or more out, no I/O. The harness owns the subscription and the session
// calls, which is what makes this mapping testable without a server.

export interface RunOutcome {
  /** The session went idle: the run is over, whatever its result. */
  idle: boolean;
  /** Set when opencode reported a failure that was not a cancellation. */
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
  /** MCP server names as configured; opencode prefixes tool ids with them. */
  mcpServers: readonly string[];
  /** Returns the UI events a create_chart call parked, given its output. */
  claimChart(output: string | undefined): ChatEvent[];
}

export function createEventMapper(opts: MapperOptions): EventMapper {
  const partTypes = new Map<string, string>();
  // Only an assistant reply to this run's question is part of this run: the
  // question arrives as a text part too, and a previous run on the session
  // can still be emitting late updates for its own replies.
  const questions = new Set<string>();
  const assistantMessages = new Set<string>();
  // An idle from before this run's prompt (a previous run winding down after
  // an abort) must not end this one, so idle counts only once it went busy.
  let busy = false;
  const progressed = new Set<string>();
  const opened = new Set<string>();
  const closed = new Set<string>();
  const costByMessage = new Map<string, number>();
  const outcome: RunOutcome = { idle: false, costUsd: 0, turns: 0 };

  const toolName = (id: string) => {
    const server = opts.mcpServers.find((s) => id.startsWith(`${s}_`));
    return server ? id.slice(server.length + 1) : id;
  };

  return {
    push(event) {
      if (sessionOf(event) !== opts.sessionId) return [];

      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part;
          const seen = partTypes.has(part.id);
          partTypes.set(part.id, part.type);

          if (part.type === "reasoning" && !seen) return [{ type: "status", text: "thinking" }];

          if (part.type === "text") {
            // A text part is re-sent as it grows; it is final once it has an
            // end time, and only then becomes a durable progress event.
            if (!assistantMessages.has(part.messageID) || !part.time?.end || progressed.has(part.id) || part.synthetic || !part.text.trim()) return [];
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
          const { partID, field, delta } = event.properties;
          const isAnswer = field === "text" && partTypes.get(partID) === "text" && assistantMessages.has(event.properties.messageID);
          return isAnswer && delta ? [{ type: "delta", text: delta }] : [];
        }

        case "message.updated": {
          const info = event.properties.info;
          if (info.role === "user") questions.add(info.id);
          if (info.role === "assistant" && questions.has(info.parentID)) {
            assistantMessages.add(info.id);
            costByMessage.set(info.id, info.cost ?? 0);
            outcome.turns = costByMessage.size;
            outcome.costUsd = [...costByMessage.values()].reduce((a, b) => a + b, 0);
          }
          return [];
        }

        case "session.error": {
          const error = event.properties.error;
          if (!error || error.name === "MessageAbortedError") return [];
          const message = "data" in error && error.data && typeof error.data.message === "string" ? error.data.message : "";
          outcome.failure = `agent stopped: ${error.name}${message ? ` — ${message.slice(0, 300)}` : ""}`;
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
          if (status.type === "busy") busy = true;
          // A provider retry can take a while; say so instead of going quiet.
          return status.type === "retry" ? [{ type: "status", text: `retrying: ${status.message}` }] : [];
        }

        case "session.idle":
          if (busy) outcome.idle = true;
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
