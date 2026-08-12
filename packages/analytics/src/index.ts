import { runAgent, type AgentConfig } from "@infino-ai/analytics-agent";
import {
  DashboardSchema,
  InMemoryStorage,
  InfinoClient,
  NewDashboardSchema,
  NewVisualizationSchema,
  VisualizationSchema,
  execute,
  isPersistentEvent,
  mergePatch,
  newDashboard,
  newVisualization,
  type ChatEvent,
  type Dashboard,
  type ExecuteResult,
  type Filter,
  type NewDashboard,
  type NewVisualization,
  type StorageAdapter,
  type ThreadStore,
  type TimeRange,
  type Visualization,
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
  DocStore,
  Thread,
  StoredMessage,
  NewMessage,
  Visualization,
  Dashboard,
  Panel,
  Filter,
  FilterOperator,
  TimeRange,
  NewVisualization,
  NewDashboard,
} from "@infino-ai/analytics-core";
export {
  InMemoryStorage,
  VisualizationSchema,
  DashboardSchema,
  NewVisualizationSchema,
  NewDashboardSchema,
} from "@infino-ai/analytics-core";

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

export interface ExecuteVizOptions {
  /** Runtime filters, AND-merged into the SQL; they win over the
   * visualization's saved filters on field collision. */
  filters?: Filter[];
  /** Absolute window applied on the spec's time column; overrides the
   * visualization's saved time_range. */
  timeRange?: TimeRange;
}

/** The persistence + execution surface for saved charts. Pure data plane:
 * no LLM anywhere in this path. */
export interface Visualizations {
  /** Lenient create: identity and defaults are filled server-side. The
   * input shape is a VizSpec plus optional filters/tags — exactly what a
   * chart event carries, so pinning from chat is `create({...event.spec})`. */
  create(input: NewVisualization): Promise<Visualization>;
  get(id: string): Promise<Visualization | null>;
  list(opts?: { ids?: string[]; limit?: number; offset?: number }): Promise<Visualization[]>;
  /** Strict full-document replace (PUT semantics). */
  put(id: string, input: NewVisualization): Promise<Visualization>;
  /** RFC 7396 merge patch; id/schema_version/created_* are protected. */
  update(id: string, patch: unknown): Promise<Visualization>;
  delete(id: string): Promise<void>;
  /** Execute a saved visualization (by id) or an ephemeral inline spec,
   * with runtime filters and time range injected into the SQL. */
  execute(idOrSpec: string | NewVisualization, opts?: ExecuteVizOptions): Promise<ExecuteResult>;
}

export interface Dashboards {
  create(input: NewDashboard): Promise<Dashboard>;
  get(id: string): Promise<Dashboard | null>;
  list(opts?: { ids?: string[]; limit?: number; offset?: number }): Promise<Dashboard[]>;
  put(id: string, input: NewDashboard): Promise<Dashboard>;
  update(id: string, patch: unknown): Promise<Dashboard>;
  delete(id: string): Promise<void>;
}

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
  private readonly client: InfinoClient;

  /** Thread CRUD + transcripts, straight from the storage adapter. */
  readonly threads: ThreadStore;
  /** Saved charts: persistence + execution. No LLM in this path. */
  readonly visualizations: Visualizations;
  /** Saved dashboards: persistence. Consumers fan out one
   * visualizations.execute() per panel with merged filters — layout and
   * rendering are theirs. */
  readonly dashboards: Dashboards;

  constructor(config: AnalyticsConfig) {
    this.agentConfig = {
      infino: config.infino,
      model: config.llm?.model,
      anthropicApiKey: config.llm?.anthropicApiKey,
      maxBudgetUsd: config.llm?.maxBudgetUsd,
    };
    this.storage = config.storage ?? new InMemoryStorage();
    this.threads = this.storage.threads;
    this.client = new InfinoClient(config.infino);
    this.visualizations = buildVisualizations(this.storage, this.client);
    this.dashboards = buildDashboards(this.storage);
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

// ── the persistence surfaces ───────────────────────────────────────────────

function buildVisualizations(storage: StorageAdapter, client: InfinoClient): Visualizations {
  const store = storage.visualizations;
  return {
    async create(input) {
      const doc = newVisualization(NewVisualizationSchema.parse(input));
      await store.put(doc);
      return doc;
    },
    get: (id) => store.get(id),
    list: (opts) => store.list(opts),
    async put(id, input) {
      const existing = await store.get(id);
      const now = new Date().toISOString();
      const doc = {
        ...newVisualization(NewVisualizationSchema.parse(input)),
        id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await store.put(doc);
      return doc;
    },
    async update(id, patch) {
      const existing = await store.get(id);
      if (!existing) throw new Error(`unknown visualization: ${id}`);
      const doc = VisualizationSchema.parse(mergePatch(existing, patch));
      await store.put(doc);
      return doc;
    },
    delete: (id) => store.delete(id),
    async execute(idOrSpec, opts = {}) {
      // Both branches produce the defaults-filled document shape: loaded
      // from storage, or parsed from the inline (ephemeral) spec.
      let spec: Omit<Visualization, "id" | "created_at" | "updated_at">;
      if (typeof idOrSpec === "string") {
        const doc = await store.get(idOrSpec);
        if (!doc) throw new Error(`unknown visualization: ${idOrSpec}`);
        spec = doc;
      } else {
        spec = NewVisualizationSchema.parse(idOrSpec);
      }
      return execute(client, spec, {
        savedFilters: spec.filters,
        filters: opts.filters,
        timeRange: opts.timeRange ?? spec.time_range,
      });
    },
  };
}

function buildDashboards(storage: StorageAdapter): Dashboards {
  const store = storage.dashboards;

  // Validation improvement over legacy: dashboards reference
  // visualizations by id, so dangling references fail at write time, not
  // at render time.
  async function checkRefs(panels: Dashboard["panels"]): Promise<void> {
    const ids = panels.flatMap((p) => (p.kind === "visualization" ? [p.viz_id] : []));
    if (ids.length === 0) return;
    const found = new Set((await storage.visualizations.list({ ids })).map((v) => v.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`dashboard references unknown visualizations: ${missing.join(", ")}`);
    }
  }

  return {
    async create(input) {
      const doc = newDashboard(NewDashboardSchema.parse(input));
      await checkRefs(doc.panels);
      await store.put(doc);
      return doc;
    },
    get: (id) => store.get(id),
    list: (opts) => store.list(opts),
    async put(id, input) {
      const existing = await store.get(id);
      const now = new Date().toISOString();
      const doc = {
        ...newDashboard(NewDashboardSchema.parse(input)),
        id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await checkRefs(doc.panels);
      await store.put(doc);
      return doc;
    },
    async update(id, patch) {
      const existing = await store.get(id);
      if (!existing) throw new Error(`unknown dashboard: ${id}`);
      const doc = DashboardSchema.parse(mergePatch(existing, patch));
      await checkRefs(doc.panels);
      await store.put(doc);
      return doc;
    },
    delete: (id) => store.delete(id),
  };
}
