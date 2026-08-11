import { randomUUID } from "node:crypto";
import type {
  NewMessage,
  StorageAdapter,
  StoredMessage,
  Thread,
  ThreadStore,
} from "@infino-ai/analytics-core";

// A StorageAdapter backed by Infino itself: threads live as two tables in
// an Infino database, so a deployment that already runs on Infino Cloud
// needs no second datastore at all.
//
// The engine's mutation model fits this workload directly: appends for new
// rows, predicate update/delete (tombstone + append inside the engine) for
// the rare mutations (rename, session pointer, thread delete). What the
// engine does NOT give is read-your-own-write: an appended row takes a few
// seconds to become queryable. The adapter absorbs that with a
// write-through cache — every write lands in the cache and the engine
// together, reads prefer the cache and fall back to the engine for
// anything written before this process started. Same single-process
// assumption as the SQLite default.

export interface InfinoStorageOptions {
  /** Database URI: https://<host>/<database> — typically the same database
   * the analytics run against. */
  uri: string;
  /** Falls back to INFINO_API_KEY. */
  apiKey?: string;
  /** Table-name prefix, default "fino_" (tables: <prefix>threads,
   * <prefix>messages). */
  tablePrefix?: string;
}

const MAX_RETRIES = 5;

interface ThreadRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  agent_session_id: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  created_at: number;
  seq: number;
  content: string;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentSessionId: row.agent_session_id || undefined,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  const base = { id: row.id, threadId: row.thread_id, createdAt: row.created_at };
  return row.role === "user"
    ? { ...base, role: "user", text: JSON.parse(row.content).text }
    : { ...base, role: "assistant", events: JSON.parse(row.content).events };
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class InfinoStorage implements StorageAdapter {
  readonly threads: ThreadStore;

  private readonly host: string;
  private readonly database: string;
  private readonly apiKey: string;
  private readonly tThreads: string;
  private readonly tMessages: string;
  private ready: Promise<void> | undefined;

  // Write-through cache. threadsCache holds every thread this process has
  // seen; messagesCache holds full transcripts, keyed by thread, loaded
  // lazily from the engine on first read.
  private readonly threadsCache = new Map<string, Thread>();
  private readonly messagesCache = new Map<string, StoredMessage[]>();
  private readonly deleted = new Set<string>();
  private seqCounter = 0;

  constructor(options: InfinoStorageOptions) {
    const url = new URL(options.uri);
    this.database = url.pathname.replace(/^\/|\/$/g, "");
    if (!this.database) throw new Error("uri must be https://<host>/<database>");
    this.host = `${url.protocol}//${url.host}`;
    this.apiKey = options.apiKey ?? process.env.INFINO_API_KEY ?? "";
    const prefix = options.tablePrefix ?? "fino_";
    this.tThreads = `${prefix}threads`;
    this.tMessages = `${prefix}messages`;
    this.threads = this.buildStore();
  }

  private async api(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.host}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // 503 = database activating; brief and worth waiting out.
      if (res.status === 503 && attempt < MAX_RETRIES) {
        const wait = Number(res.headers.get("retry-after")) || 3;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  private sql(query: string): Promise<Record<string, unknown>[]> {
    return this.api(`/v1/query_sql/${this.database}`, { query }) as Promise<
      Record<string, unknown>[]
    >;
  }

  /** Create the two tables once per process; existing tables are fine. */
  private ensureTables(): Promise<void> {
    this.ready ??= (async () => {
      const mk = async (table_name: string, schema: object[]) => {
        try {
          await this.api(`/v1/create_table/${this.database}`, { table_name, schema });
        } catch (err) {
          if (!/exist/i.test(String(err))) throw err;
        }
      };
      await mk(this.tThreads, [
        { name: "id", type: "utf8", nullable: false },
        { name: "title", type: "utf8", nullable: false },
        { name: "created_at", type: "i64", nullable: false },
        { name: "updated_at", type: "i64", nullable: false },
        { name: "agent_session_id", type: "utf8", nullable: true },
      ]);
      await mk(this.tMessages, [
        { name: "id", type: "utf8", nullable: false },
        { name: "thread_id", type: "utf8", nullable: false },
        { name: "role", type: "utf8", nullable: false },
        { name: "created_at", type: "i64", nullable: false },
        { name: "seq", type: "i64", nullable: false },
        { name: "content", type: "utf8", nullable: false },
      ]);
    })();
    return this.ready;
  }

  /** Monotonic per-process sequence for message ordering: epoch ms scaled,
   * plus a counter so same-millisecond appends stay ordered. */
  private nextSeq(): number {
    return Date.now() * 1000 + (this.seqCounter = (this.seqCounter + 1) % 1000);
  }

  private threadRowOf(t: Thread): ThreadRow {
    return {
      id: t.id,
      title: t.title,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      agent_session_id: t.agentSessionId ?? null,
    };
  }

  /** Full-row replacement via the engine's predicate update. */
  private async replaceThreadRow(t: Thread): Promise<void> {
    const predicate = encodeURIComponent(`id = ${sqlQuote(t.id)}`);
    await this.api(`/v1/update/${this.database}?table=${this.tThreads}&predicate=${predicate}`, {
      data: [this.threadRowOf(t)],
    });
  }

  private async loadThread(id: string): Promise<Thread | null> {
    if (this.deleted.has(id)) return null;
    const cached = this.threadsCache.get(id);
    if (cached) return { ...cached };
    const rows = (await this.sql(
      `SELECT * FROM ${this.tThreads} WHERE id = ${sqlQuote(id)}`,
    )) as unknown as ThreadRow[];
    if (rows.length === 0) return null;
    const thread = toThread(rows[0]);
    this.threadsCache.set(id, thread);
    return { ...thread };
  }

  private async loadMessages(threadId: string): Promise<StoredMessage[]> {
    let msgs = this.messagesCache.get(threadId);
    if (!msgs) {
      const rows = (await this.sql(
        `SELECT * FROM ${this.tMessages} WHERE thread_id = ${sqlQuote(threadId)} ORDER BY seq ASC`,
      )) as unknown as MessageRow[];
      msgs = rows.map(toMessage);
      this.messagesCache.set(threadId, msgs);
    }
    return msgs;
  }

  private buildStore(): ThreadStore {
    const self = this;
    return {
      async create(opts) {
        await self.ensureTables();
        const now = Date.now();
        const thread: Thread = {
          id: opts?.id ?? randomUUID(),
          title: opts?.title ?? "",
          createdAt: now,
          updatedAt: now,
        };
        self.threadsCache.set(thread.id, thread);
        self.messagesCache.set(thread.id, []);
        await self.api(`/v1/append/${self.database}?table=${self.tThreads}`, {
          data: [self.threadRowOf(thread)],
        });
        return { ...thread };
      },

      async get(id) {
        await self.ensureTables();
        return self.loadThread(id);
      },

      async list(opts) {
        await self.ensureTables();
        const limit = opts?.limit ?? 50;
        const before = opts?.before;
        // Engine view (durable) overlaid with the cache (fresher): rows
        // written seconds ago may not be queryable yet, and cached rows may
        // carry newer titles/timestamps than their engine copies.
        const rows = (await self.sqlSafe(before)) as ThreadRow[];
        const byId = new Map<string, Thread>(rows.map((r) => [r.id, toThread(r)]));
        for (const t of self.threadsCache.values()) byId.set(t.id, t);
        return [...byId.values()]
          .filter((t) => !self.deleted.has(t.id))
          .filter((t) => (before === undefined ? true : t.updatedAt < before))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit)
          .map((t) => ({ ...t }));
      },

      async rename(id, title) {
        await self.ensureTables();
        const thread = await self.loadThread(id);
        if (!thread) throw new Error(`unknown thread: ${id}`);
        thread.title = title;
        thread.updatedAt = Date.now();
        self.threadsCache.set(id, thread);
        await self.replaceThreadRow(thread);
      },

      async delete(id) {
        await self.ensureTables();
        self.threadsCache.delete(id);
        self.messagesCache.delete(id);
        self.deleted.add(id);
        const byThread = encodeURIComponent(`thread_id = ${sqlQuote(id)}`);
        const byId = encodeURIComponent(`id = ${sqlQuote(id)}`);
        await self.apiSafe(`/v1/delete/${self.database}?table=${self.tMessages}&predicate=${byThread}`);
        await self.apiSafe(`/v1/delete/${self.database}?table=${self.tThreads}&predicate=${byId}`);
      },

      async setAgentSession(id, agentSessionId) {
        await self.ensureTables();
        const thread = await self.loadThread(id);
        if (!thread) throw new Error(`unknown thread: ${id}`);
        thread.agentSessionId = agentSessionId;
        self.threadsCache.set(id, thread);
        await self.replaceThreadRow(thread);
      },

      async appendMessage(threadId, message: NewMessage) {
        await self.ensureTables();
        const thread = await self.loadThread(threadId);
        if (!thread) throw new Error(`unknown thread: ${threadId}`);
        const msgs = await self.loadMessages(threadId);

        const id = message.id ?? randomUUID();
        if (msgs.some((m) => m.id === id)) throw new Error(`duplicate message id: ${id}`);

        const now = Date.now();
        const stored: StoredMessage =
          message.role === "user"
            ? { id, threadId, role: "user", createdAt: now, text: message.text }
            : { id, threadId, role: "assistant", createdAt: now, events: message.events };
        msgs.push(stored);
        thread.updatedAt = now;
        self.threadsCache.set(threadId, thread);

        const content =
          message.role === "user"
            ? JSON.stringify({ text: message.text })
            : JSON.stringify({ events: message.events });
        await self.api(`/v1/append/${self.database}?table=${self.tMessages}`, {
          data: [
            { id, thread_id: threadId, role: message.role, created_at: now, seq: self.nextSeq(), content },
          ],
        });
        await self.replaceThreadRow(thread);
        return stored;
      },

      async listMessages(threadId, opts) {
        await self.ensureTables();
        const all = await self.loadMessages(threadId);
        const upTo = opts?.before ? all.findIndex((m) => m.id === opts.before) : all.length;
        const end = upTo === -1 ? all.length : upTo;
        const limit = opts?.limit ?? 100;
        return all.slice(Math.max(0, end - limit), end);
      },
    };
  }

  // list() must survive the tables not existing yet on a fresh database
  // (nothing written, nothing to list), and delete() must not fail the
  // caller when a row only exists in the not-yet-queryable window — the
  // cache/tombstone already reflect the intent.
  private async sqlSafe(before?: number): Promise<unknown[]> {
    try {
      const where = before === undefined ? "" : ` WHERE updated_at < ${Math.floor(before)}`;
      return await this.sql(
        `SELECT * FROM ${this.tThreads}${where} ORDER BY updated_at DESC LIMIT 200`,
      );
    } catch {
      return [];
    }
  }

  private async apiSafe(path: string): Promise<void> {
    try {
      await this.api(path);
    } catch {
      // Engine-side rows in the ingest window get removed on the next
      // delete of the same thread id; the local tombstone hides them
      // from this process regardless.
    }
  }
}
