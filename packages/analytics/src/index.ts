import { runAgent, type AgentConfig } from "@infino-ai/analytics-agent";
import {
  InMemoryStorage,
  isPersistentEvent,
  type ChatEvent,
  type StorageAdapter,
  type ThreadStore,
} from "@infino-ai/analytics-core";

export type {
  ChatEvent,
  VizSpec,
  Binding,
  ExecuteResult,
  Warning,
  ChartType,
  StorageAdapter,
  ThreadStore,
  Thread,
  StoredMessage,
  NewMessage,
} from "@infino-ai/analytics-core";
export { InMemoryStorage } from "@infino-ai/analytics-core";

export interface AnalyticsConfig {
  /** Infino target: hosted https://<host>/<database>. The apiKey falls back
   * to INFINO_API_KEY. */
  infino: { uri: string; apiKey?: string };
  /** LLM seam — needed only for the conversational surface (ask). The
   * visualization/dashboard surfaces never touch it. Default harness is the
   * Claude Agent SDK; the key falls back to ANTHROPIC_API_KEY. */
  llm?: { model?: string; anthropicApiKey?: string; maxBudgetUsd?: number };
  /** Storage seam. Defaults to InMemoryStorage (nothing survives a
   * restart); pass SqliteStorage or your own StorageAdapter for
   * persistence. Consumers of this class never change when it does. */
  storage?: StorageAdapter;
}

const TITLE_MAX = 80;

/**
 * The facade: one client object with everything on it, in the spirit of a
 * classic flat SDK. Two co-equal surfaces:
 *
 * - `ask()` + `threads` — Fino, the conversational agent. Requires LLM
 *   access. Threads persist through the storage adapter: metadata, the
 *   full transcript (what the user saw, charts included), and the
 *   agent-harness session pointer that lets a reopened thread resume with
 *   the model's context.
 * - `visualizations` / `dashboards` (next phase) — the persistence and
 *   execution API for charts and dashboards. Pure data plane: consumable
 *   entirely without Fino or any LLM, exactly like a classic analytics
 *   backend.
 */
export class Analytics {
  private readonly agentConfig: AgentConfig;
  private readonly storage: StorageAdapter;

  /** Thread CRUD + transcripts, straight from the storage adapter. */
  readonly threads: ThreadStore;

  constructor(config: AnalyticsConfig) {
    this.agentConfig = {
      infino: config.infino,
      model: config.llm?.model,
      anthropicApiKey: config.llm?.anthropicApiKey,
      maxBudgetUsd: config.llm?.maxBudgetUsd,
    };
    this.storage = config.storage ?? new InMemoryStorage();
    this.threads = this.storage.threads;
  }

  /** Create a thread and return its id — sugar over threads.create() that
   * keeps the original session-flavored surface working. */
  async createSession(): Promise<string> {
    return (await this.threads.create()).id;
  }

  /** Ask a question (the Fino surface). Yields typed events (progress, sql,
   * chart, summary, error, done). With a threadId, the turn is persisted
   * (the question plus everything shown) and follow-ups continue the
   * conversation; without one, the run is one-shot and leaves no trace. */
  async *ask(
    question: string,
    opts: { threadId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatEvent> {
    const thread = opts.threadId ? await this.threads.get(opts.threadId) : null;
    if (opts.threadId && !thread) {
      throw new Error(`unknown thread: ${opts.threadId}`);
    }

    if (thread) {
      await this.threads.appendMessage(thread.id, { role: "user", text: question });
      if (!thread.title) {
        const title =
          question.length > TITLE_MAX ? `${question.slice(0, TITLE_MAX - 1)}…` : question;
        await this.threads.rename(thread.id, title);
      }
    }

    const run = runAgent({
      question,
      config: this.agentConfig,
      resumeSessionId: thread?.agentSessionId,
      signal: opts.signal,
    });

    // Everything the user saw this turn — including a partial turn ended by
    // abort or error — becomes one assistant message when the run ends.
    const turnEvents: ChatEvent[] = [];
    let agentSessionId: string | undefined;

    try {
      // Manual iteration so the generator's return value (the harness
      // session id) can be captured for follow-ups.
      while (true) {
        const next = await run.next();
        if (next.done) {
          agentSessionId = next.value?.sessionId ?? agentSessionId;
          break;
        }
        const event = next.value;
        if (event.type === "done" && event.sessionId) agentSessionId = event.sessionId;
        if (isPersistentEvent(event)) turnEvents.push(event);
        yield event;
      }
    } finally {
      if (thread) {
        if (turnEvents.length > 0) {
          await this.threads.appendMessage(thread.id, { role: "assistant", events: turnEvents });
        }
        if (agentSessionId) {
          await this.threads.setAgentSession(thread.id, agentSessionId);
        }
      }
    }
  }
}
