import {
  InfinoClient,
  buildSystemPrompt,
  drain,
  type AgentHarness,
  type ChatEvent,
  type InfinoConfig,
} from "@infino-ai/analytics-core";
import type { Event } from "@opencode-ai/sdk/v2";
import { startOpencode, type OpencodeBackend, type OpencodeServer } from "./server.js";
import { createEventMapper, sessionOf, type EventMapper } from "./stream.js";

export type { OpencodeBackend } from "./server.js";

// A harness behind the same ChatEvent contract, driven through opencode: the
// opencode server runs the turn loop and the model call, against whichever
// provider the model id names. The Infino data tools and the chart contract
// reach it as MCP servers; every built-in opencode tool is switched off.
//
// Where it differs from the contract's fuller harnesses:
//   - No `summary` event. The final text arrives once, as a text part, so a
//     summary would only duplicate the last `progress`.
//   - No web search. The prompt drops that promise accordingly.
//   - The budget ceiling is checked as each model call reports its cost, so it
//     bounds a runaway loop but not a single expensive call.

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_BUDGET_USD = 2;
const DEFAULT_DATA_DIR = "./data/opencode";
// Generous because a scan of a large table legitimately runs for a minute;
// a call past it fails as a tool error the model can read and work around.
const DEFAULT_MCP_TIMEOUT_MS = 120_000;
// Silence beyond the longest tool call plus a slow model turn means opencode
// is stuck, not busy.
const STALL_MARGIN_MS = 180_000;
// After the harness stops a run, opencode normally confirms within a second.
const STOP_GRACE_MS = 10_000;

export interface OpencodeConfig {
  infino: InfinoConfig;
  /** "<provider>/<model>" as opencode names it. Falls back to OPENCODE_MODEL.
   * Provider credentials are read from the environment by opencode itself. */
  model?: string;
  /** Operator-supplied notes about the dataset, appended to the system prompt
   * as ground truth. */
  domainContext?: string;
  maxTurns?: number;
  /** Per-question spend ceiling in USD, as opencode prices it (default 2). */
  maxBudgetUsd?: number;
  /** Longest a single tool call may run, in ms (default 120000). Covers the
   * data tools and create_chart alike. */
  mcpTimeoutMs?: number;
  /** How long a run may go without one event of its own before it is stopped
   * as stuck, in ms (default: the tool timeout plus three minutes). */
  stallTimeoutMs?: number;
  /** Where opencode keeps sessions (default ./data/opencode). A thread can
   * resume only while this directory survives. */
  dataDir?: string;
  /** Explicit opencode binary; defaults to the one npm installed. */
  binary?: string;
}

/** The provider boundary, injectable so the conformance suite can drive the
 * real harness without spawning opencode. Production passes nothing. */
export interface OpencodeSeams {
  backend?: OpencodeBackend;
}

/** Build the opencode harness. The server boots on the first question and is
 * shared by every run after it. */
export function createOpencodeHarness(config: OpencodeConfig, seams: OpencodeSeams = {}): AgentHarness {
  const model = seams.backend ? "" : modelId(config.model ?? process.env.OPENCODE_MODEL);
  const maxBudgetUsd = config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const mcpTimeoutMs = config.mcpTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const stallTimeoutMs = config.stallTimeoutMs ?? mcpTimeoutMs + STALL_MARGIN_MS;
  const stopGraceMs = Math.min(STOP_GRACE_MS, stallTimeoutMs);
  let booting: Promise<OpencodeServer> | undefined;

  const backendFor = async (): Promise<OpencodeBackend> => {
    if (seams.backend) return seams.backend;
    for (;;) {
      const current = (booting ??= startOpencode({
        infino: new InfinoClient(config.infino),
        infinoApiKey: config.infino.apiKey ?? process.env.INFINO_API_KEY ?? "",
        model,
        // No web-search tool on this path, so the contract must not offer one.
        systemPrompt: buildSystemPrompt({ domainContext: config.domainContext }),
        maxSteps: config.maxTurns ?? DEFAULT_MAX_TURNS,
        mcpTimeoutMs,
        dataDir: config.dataDir ?? DEFAULT_DATA_DIR,
        binary: config.binary,
      }));
      // Concurrent runs find a dead or failed server together; only the one
      // still holding it clears it, so exactly one replacement boots.
      let server: OpencodeServer;
      try {
        server = await current;
      } catch (err) {
        if (booting === current) booting = undefined;
        throw err;
      }
      if (server.alive()) return server.backend;
      if (booting === current) {
        booting = undefined;
        void server.close();
      }
    }
  };

  return async function* opencodeHarness(params) {
    const abort = new AbortController();
    if (params.signal) {
      if (params.signal.aborted) abort.abort();
      else params.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    // The subscription ends with the run on every exit path, without that
    // alone signalling a cancellation to opencode.
    const subscription = new AbortController();
    abort.signal.addEventListener("abort", () => subscription.abort(), { once: true });
    // Every wait on opencode gives way to a cancellation, so a wedged server
    // cannot hold a stopped run open.
    const orAbort = <T>(work: Promise<T>) => untilAborted(work, abort.signal);

    let sessionId = params.resumeSessionId;
    let backend: OpencodeBackend | undefined;
    let mapper: EventMapper | undefined;
    let promptCall: Promise<void> | undefined;
    let finished = false; // opencode went idle after this run's prompt
    let abortSent = false;
    // Every path that cancels the session goes through here, so opencode is
    // told once however many reasons to stop pile up.
    const abortSession = () => {
      if (abortSent || !backend || !sessionId) return;
      abortSent = true;
      void backend.abort(sessionId);
    };
    const pending: ChatEvent[] = [];

    try {
      abort.signal.throwIfAborted();
      backend = await orAbort(backendFor());
      const b = backend;

      // A thread outliving opencode's data directory points at nothing.
      // Starting over is allowed by the thread contract; the transcript still
      // renders. Any other lookup failure is a real error and propagates.
      if (sessionId && !(await orAbort(b.hasSession(sessionId)))) sessionId = undefined;
      sessionId ??= await orAbort(b.createSession());
      const id = sessionId;
      const map = createEventMapper({
        sessionId: id,
        mcpServers: b.mcpServers,
        claimChart: (output) => b.claimChart(output),
      });
      mapper = map;

      // Subscribed before prompting, so no event of this run is missed.
      const events = (await orAbort(b.subscribe(subscription.signal)))[Symbol.asyncIterator]();

      // One prompt per session at a time. A previous run on this thread can
      // still be winding down (a stopped answer whose tool call is finishing);
      // prompting over it would let its closing events end this run early.
      if (await orAbort(b.isBusy(id))) {
        await orAbort(b.abort(id));
        if (!(await settled(events, id, Date.now() + stopGraceMs, subscription))) {
          throw new Error("agent stopped: the previous answer on this thread is still finishing; ask again in a moment");
        }
      }
      promptCall = b.prompt(id, params.question);
      await orAbort(promptCall);

      let failure: string | undefined;
      const stop = (reason: string) => {
        failure ??= reason;
        abortSession();
      };
      // The stall clock runs only while waiting on opencode, never while the
      // consumer holds a yielded event, and only this session's events reset
      // it. After a stop, opencode gets a short grace to wind down.
      let deadline = Date.now() + stallTimeoutMs;
      for (;;) {
        const limit = failure ? Math.min(deadline, Date.now() + stopGraceMs) : deadline;
        const next = await nextBefore(events, limit, subscription);
        if (next === STALLED) {
          failure ??= `agent stopped: no progress from opencode in ${Math.round(stallTimeoutMs / 1000)} s`;
          abortSession();
          break;
        }
        if (next.done) break;
        if (sessionOf(next.value) !== id) continue;
        pending.push(...map.push(next.value));
        yield* drain(pending);
        deadline = Date.now() + stallTimeoutMs;
        const outcome = map.outcome();
        if (outcome.blocked) stop(outcome.blocked);
        else if (outcome.costUsd > maxBudgetUsd) stop(`agent stopped: budget of $${maxBudgetUsd} exceeded`);
        if (outcome.idle) {
          finished = true;
          break;
        }
      }
      abort.signal.throwIfAborted();

      const outcome = map.outcome();
      failure ??= outcome.failure ?? (outcome.idle ? undefined : "agent stopped: opencode event stream ended mid-run");
      if (failure) yield { type: "error", message: failure };
      yield { type: "done", sessionId: id, turns: outcome.turns, costUsd: outcome.costUsd };
    } catch (err) {
      yield* drain(pending);
      // Cancellation is a normal outcome, not an error: the ChatEvent contract
      // requires abort to yield `done`, and assertHarnessConformance checks it.
      if (!abort.signal.aborted) {
        yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      }
      const outcome = mapper?.outcome();
      yield { type: "done", sessionId: sessionId ?? "", turns: outcome?.turns, costUsd: outcome?.costUsd };
    } finally {
      subscription.abort();
      // Cancellation, a stop, and a consumer abandoning this generator all end
      // here; none may leave the model spending in the background. The abort
      // waits for the prompt request to land, or opencode could see it first
      // and then start the prompt anyway.
      if (promptCall && !finished) void promptCall.catch(() => {}).then(abortSession);
    }

    return { sessionId };
  };
}

const STALLED = Symbol("stalled");

/** Reads events until the session goes idle; false if it does not before
 * `deadline`. */
async function settled(
  events: AsyncIterator<Event>,
  sessionId: string,
  deadline: number,
  subscription: AbortController,
): Promise<boolean> {
  for (;;) {
    const next = await nextBefore(events, deadline, subscription);
    if (next === STALLED || next.done) return false;
    if (next.value.type === "session.idle" && next.value.properties.sessionID === sessionId) return true;
  }
}

/** The next stream event, or STALLED once `deadline` passes. A stall closes
 * the subscription, which is what releases the pending read. */
async function nextBefore(
  events: AsyncIterator<Event>,
  deadline: number,
  subscription: AbortController,
): Promise<IteratorResult<Event> | typeof STALLED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), Math.max(0, deadline - Date.now()));
  });
  const read = events.next();
  // A stall abandons this read; its rejection, when the subscription closes,
  // is expected.
  read.catch(() => {});
  try {
    const next = await Promise.race([read, stalled]);
    if (next === STALLED) subscription.abort();
    return next;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with `work`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Requires the "<provider>/<model>" shape at construction, so a bare model
 * name fails at boot rather than on the first question. */
function modelId(value: string | undefined): string {
  if (!value) throw new Error("OPENCODE_MODEL is not set");
  if (!/^[^/]+\/.+/.test(value)) {
    throw new Error(`OPENCODE_MODEL must be "<provider>/<model>" (got ${value})`);
  }
  return value;
}
