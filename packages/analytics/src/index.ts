import { randomUUID } from "node:crypto";
import { runAgent, type AgentConfig } from "@infino-ai/analytics-agent";
import type { ChatEvent } from "@infino-ai/analytics-viz-core";

export type {
  ChatEvent,
  VizSpec,
  Binding,
  ExecuteResult,
  Warning,
  ChartType,
} from "@infino-ai/analytics-viz-core";

export interface AnalyticsConfig {
  /** Infino target: hosted https://<host>/<database>. The apiKey falls back
   * to INFINO_API_KEY. */
  infino: { uri: string; apiKey?: string };
  /** LLM seam — needed only for the conversational surface (ask). The
   * visualization/dashboard surfaces never touch it. Default harness is the
   * Claude Agent SDK; the key falls back to ANTHROPIC_API_KEY. */
  llm?: { model?: string; anthropicApiKey?: string; maxBudgetUsd?: number };
}

interface SessionState {
  id: string;
  createdAt: number;
  /** Agent-harness conversation id, set after the first ask. */
  agentSessionId?: string;
}

/**
 * The facade: one client object with everything on it, in the spirit of a
 * classic flat SDK. Two co-equal surfaces:
 *
 * - `ask()` + sessions — Fino, the conversational agent. Requires LLM access.
 * - `visualizations` / `dashboards` (next phase) — the persistence and
 *   execution API for charts and dashboards. Pure data plane: consumable
 *   entirely without Fino or any LLM, exactly like a classic analytics
 *   backend.
 *
 * Sessions are in-memory for now — a StorageAdapter takes over when thread
 * persistence ships.
 */
export class Analytics {
  private readonly agentConfig: AgentConfig;
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: AnalyticsConfig) {
    this.agentConfig = {
      infino: config.infino,
      model: config.llm?.model,
      anthropicApiKey: config.llm?.anthropicApiKey,
      maxBudgetUsd: config.llm?.maxBudgetUsd,
    };
  }

  createSession(): string {
    const id = randomUUID();
    this.sessions.set(id, { id, createdAt: Date.now() });
    return id;
  }

  /** Ask a question (the Fino surface). Yields typed events (progress, sql,
   * chart, summary, error, done). With a sessionId, follow-ups continue the
   * conversation. */
  async *ask(
    question: string,
    opts: { sessionId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatEvent> {
    const session = opts.sessionId ? this.sessions.get(opts.sessionId) : undefined;
    if (opts.sessionId && !session) {
      throw new Error(`unknown session: ${opts.sessionId}`);
    }

    const run = runAgent({
      question,
      config: this.agentConfig,
      resumeSessionId: session?.agentSessionId,
      signal: opts.signal,
    });

    // Manual iteration so the generator's return value (the harness session
    // id) can be captured for follow-ups.
    while (true) {
      const next = await run.next();
      if (next.done) {
        if (session && next.value?.sessionId) {
          session.agentSessionId = next.value.sessionId;
        }
        return;
      }
      const event = next.value;
      if (session && event.type === "done" && event.sessionId) {
        session.agentSessionId = event.sessionId;
      }
      yield event;
    }
  }
}
