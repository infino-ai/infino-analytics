import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { stepDetail, type ChatEvent } from "@infino-ai/analytics-core";

// Responses stream → ChatEvent. Pure and synchronous: one event in, zero or
// more out, no I/O. The turn loop owns everything else, which is what makes
// this mapping testable without a network.

export interface PendingCall {
  callId: string;
  name: string;
  args: string;
}

export interface TurnOutcome {
  /** "open" means the stream ended with no terminal event — a real failure
   * mode behind a proxy, and never a silent success. */
  status: "open" | "completed" | "incomplete" | "failed";
  responseId?: string;
  calls: PendingCall[];
  /** Why a non-completed turn stopped: content_filter, max_output_tokens, an
   * API message. */
  stopReason?: string;
  totalTokens: number;
  lastText?: string;
}

export interface TurnMapper {
  push(event: ResponseStreamEvent): ChatEvent[];
  outcome(): TurnOutcome;
}

export function createTurnMapper(): TurnMapper {
  const outcome: TurnOutcome = { status: "open", calls: [], totalTokens: 0 };

  return {
    push(event) {
      switch (event.type) {
        case "response.created":
          outcome.responseId = event.response.id;
          return [];

        case "response.output_item.added":
          // Reasoning is the one place a run can go quiet for a long time.
          if (event.item.type === "reasoning") return [{ type: "status", text: "thinking" }];
          // A function_call item arrives with empty arguments — the step
          // itself waits for .done, so flag the call by name meanwhile.
          if (event.item.type === "function_call") {
            return [{ type: "status", text: `calling ${event.item.name}` }];
          }
          return [];

        case "response.output_text.delta":
          return [{ type: "delta", text: event.delta }];

        case "response.output_item.done": {
          const item = event.item;
          if (item.type === "message") {
            const text = item.content
              .map((part) => (part.type === "output_text" ? part.text : ""))
              .join("");
            if (!text.trim()) return [];
            outcome.lastText = text;
            return [{ type: "progress", text }];
          }
          if (item.type === "function_call") {
            // Arguments are only complete here, so this is where the step —
            // and its human-readable detail — can be emitted.
            outcome.calls.push({ callId: item.call_id, name: item.name, args: item.arguments });
            return [
              {
                type: "step",
                id: item.call_id,
                tool: item.name,
                detail: stepDetail(safeParse(item.arguments)),
              },
            ];
          }
          return [];
        }

        case "response.completed":
          outcome.status = "completed";
          outcome.responseId = event.response.id;
          outcome.totalTokens = event.response.usage?.total_tokens ?? 0;
          return [];

        case "response.incomplete":
          outcome.status = "incomplete";
          outcome.responseId = event.response.id;
          outcome.totalTokens = event.response.usage?.total_tokens ?? 0;
          outcome.stopReason = event.response.incomplete_details?.reason ?? "incomplete";
          return [];

        case "response.failed":
          outcome.status = "failed";
          outcome.responseId = event.response.id;
          outcome.stopReason = event.response.error?.message ?? "failed";
          return [];

        case "error":
          outcome.status = "failed";
          outcome.stopReason = event.message ?? "stream error";
          return [];

        // Azure adds fields and events of its own (content filters, and
        // whatever ships next). Ignoring the unknown is what keeps a run
        // alive through a provider-side change.
        default:
          return [];
      }
    },
    outcome: () => outcome,
  };
}

function safeParse(args: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
