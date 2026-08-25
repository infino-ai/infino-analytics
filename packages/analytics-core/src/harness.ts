import type { ChatEvent } from "./events.js";

// The LLM seam, as a type. It lives here rather than in a harness package so
// that consumers depend on the contract, not on whichever model implements it.

/** What a run leaves behind: the harness's own conversation pointer, stored
 * on the thread so a follow-up resumes with the model's context. */
export interface HarnessRunResult {
  sessionId?: string;
}

export interface HarnessRunParams {
  question: string;
  resumeSessionId?: string;
  /** Abort must cancel the underlying run, not just the event stream. */
  signal?: AbortSignal;
}

/** Any harness is a generator of ChatEvents. Model-specific configuration is
 * closed over at construction, never passed per run. */
export type AgentHarness = (
  params: HarnessRunParams,
) => AsyncGenerator<ChatEvent, HarnessRunResult>;
