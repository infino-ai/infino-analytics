import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { drain, stepResult, type ChatEvent } from "@infino-ai/analytics-core";
import { createTurnMapper } from "./stream.js";
import type { ToolRegistry } from "./tools.js";

// The bounded turn loop. Every provider call goes through the injected
// `stream`, so the whole loop runs in a unit test with no network.

export type StreamFn = (
  body: ResponseCreateParamsStreaming,
  opts: { signal: AbortSignal },
) => Promise<AsyncIterable<ResponseStreamEvent>>;

export interface LoopStats {
  turns: number;
  totalTokens: number;
}

export interface LoopOptions {
  question: string;
  instructions: string;
  model: string;
  previousResponseId?: string;
  maxTurns: number;
  maxTotalTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
  tools: ToolRegistry;
  stream: StreamFn;
  /** Side channel: tools push UI-bound events (sql, chart with full rows)
   * here so large payloads never pass through the model's context. */
  pending: ChatEvent[];
  /** Mutated as the run proceeds, so the caller can report turns after a throw. */
  stats: LoopStats;
  signal: AbortSignal;
}

/** Throws on every failure; the caller decides abort-vs-error. */
export async function* runTurns(o: LoopOptions): AsyncGenerator<ChatEvent, { sessionId?: string }> {
  let previousResponseId = o.previousResponseId;
  // Turn 1 sends the question; later turns send only the new tool results —
  // the calls themselves already live in the stored response we point at.
  let input: ResponseInput = [{ role: "user", content: o.question }];

  for (let turn = 1; ; turn++) {
    // Between turns is the one place cancellation can be noticed without
    // waiting for the provider to notice it first.
    o.signal.throwIfAborted();
    if (turn > o.maxTurns) throw new Error("agent stopped: max_turns");
    if (o.stats.totalTokens > o.maxTotalTokens) throw new Error("agent stopped: max_tokens");

    const mapper = createTurnMapper();
    // instructions are not inherited through previous_response_id.
    const events = await o.stream(
      {
        model: o.model,
        instructions: o.instructions,
        input,
        tools: o.tools.definitions,
        stream: true,
        store: true,
        previous_response_id: previousResponseId,
        ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}),
      },
      { signal: o.signal },
    );

    for await (const event of events) {
      for (const out of mapper.push(event)) yield out;
      yield* drain(o.pending);
    }

    const outcome = mapper.outcome();
    o.stats.turns = turn;
    // Each turn re-bills the whole prefix as input, so summing total_tokens
    // is what the provider charges — a cost proxy, not a context measurement.
    o.stats.totalTokens += outcome.totalTokens;

    if (outcome.status === "open") {
      throw new Error("response stream ended without a terminal event");
    }
    if (outcome.status !== "completed") {
      throw new Error(`agent stopped: ${outcome.stopReason ?? outcome.status}`);
    }

    previousResponseId = outcome.responseId;
    // Only a tool-free response is a safe resume point: an id with dangling
    // calls would resume the next question into an unanswerable state.
    if (outcome.calls.length === 0) return { sessionId: outcome.responseId };

    const outputs: ResponseInput = [];
    for (const call of outcome.calls) {
      const result = await o.tools.invoke(call.name, call.args);
      yield* drain(o.pending);
      yield { type: "step_done", id: call.callId, ok: !result.isError, result: stepResult(result.text) };
      outputs.push({ type: "function_call_output", call_id: call.callId, output: result.text });
    }
    input = outputs;
  }
}

