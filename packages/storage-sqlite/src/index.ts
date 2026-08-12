import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Dashboard,
  DocStore,
  NewMessage,
  StorageAdapter,
  StoredMessage,
  Thread,
  ThreadStore,
  Visualization,
} from "@infino-ai/analytics-core";

// The shipped default StorageAdapter: one SQLite file, no infrastructure.
// Suitable for development and single-node production alike. A different
// database is a different implementation of the same interface — consumers
// never change.

export interface SqliteStorageOptions {
  /** Database file path (parent directories are created). Default
   * ./data/analytics.db; ":memory:" works for tests. */
  path?: string;
}

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
    agentSessionId: row.agent_session_id ?? undefined,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  const base = { id: row.id, threadId: row.thread_id, createdAt: row.created_at };
  return row.role === "user"
    ? { ...base, role: "user", text: JSON.parse(row.content).text }
    : { ...base, role: "assistant", events: JSON.parse(row.content).events };
}

// One table per document kind: id + updated_at columns for listing, the
// document itself as JSON. Same pattern any database maps to.
function sqliteDocStore<T extends { id: string; updated_at: string }>(
  db: Database.Database,
  table: string,
): DocStore<T> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      doc        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_updated ON ${table}(updated_at DESC);
  `);
  const upsert = db.prepare(
    `INSERT INTO ${table} (id, updated_at, doc) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, doc = excluded.doc`,
  );
  const getOne = db.prepare(`SELECT doc FROM ${table} WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT doc FROM ${table} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  );
  const deleteOne = db.prepare(`DELETE FROM ${table} WHERE id = ?`);

  return {
    async put(doc) {
      upsert.run(doc.id, doc.updated_at, JSON.stringify(doc));
    },
    async get(id) {
      const row = getOne.get(id) as { doc: string } | undefined;
      return row ? (JSON.parse(row.doc) as T) : null;
    },
    async list(opts) {
      if (opts?.ids) {
        const docs: T[] = [];
        for (const id of opts.ids) {
          const row = getOne.get(id) as { doc: string } | undefined;
          if (row) docs.push(JSON.parse(row.doc) as T);
        }
        return docs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      }
      const rows = listAll.all(opts?.limit ?? 500, opts?.offset ?? 0) as { doc: string }[];
      return rows.map((r) => JSON.parse(r.doc) as T);
    },
    async delete(id) {
      deleteOne.run(id);
    },
  };
}

export class SqliteStorage implements StorageAdapter {
  readonly threads: ThreadStore;
  readonly visualizations: DocStore<Visualization>;
  readonly dashboards: DocStore<Dashboard>;
  private readonly db: Database.Database;

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.path ?? "./data/analytics.db";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    this.db = db;

    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    this.visualizations = sqliteDocStore<Visualization>(db, "visualizations");
    this.dashboards = sqliteDocStore<Dashboard>(db, "dashboards");
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL DEFAULT '',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        agent_session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT NOT NULL UNIQUE,
        thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        created_at INTEGER NOT NULL,
        content    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);
    `);

    const insertThread = db.prepare(
      "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    const getThread = db.prepare("SELECT * FROM threads WHERE id = ?");
    const listThreads = db.prepare(
      "SELECT * FROM threads WHERE updated_at < ? ORDER BY updated_at DESC LIMIT ?",
    );
    const renameThread = db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?");
    const touchThread = db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?");
    const deleteThread = db.prepare("DELETE FROM threads WHERE id = ?");
    const setSession = db.prepare("UPDATE threads SET agent_session_id = ? WHERE id = ?");
    const insertMessage = db.prepare(
      "INSERT INTO messages (id, thread_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)",
    );
    const seqOf = db.prepare("SELECT seq FROM messages WHERE id = ? AND thread_id = ?");
    const pageBefore = db.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    );

    const mustExist = (id: string): ThreadRow => {
      const row = getThread.get(id) as ThreadRow | undefined;
      if (!row) throw new Error(`unknown thread: ${id}`);
      return row;
    };

    // appendMessage does two writes (insert + touch); keep them atomic.
    const appendTx = db.transaction(
      (threadId: string, message: NewMessage, id: string, now: number) => {
        mustExist(threadId);
        const content =
          message.role === "user"
            ? JSON.stringify({ text: message.text })
            : JSON.stringify({ events: message.events });
        insertMessage.run(id, threadId, message.role, now, content);
        touchThread.run(now, threadId);
      },
    );

    this.threads = {
      async create(opts) {
        const now = Date.now();
        const id = opts?.id ?? randomUUID();
        insertThread.run(id, opts?.title ?? "", now, now);
        return { id, title: opts?.title ?? "", createdAt: now, updatedAt: now };
      },
      async get(id) {
        const row = getThread.get(id) as ThreadRow | undefined;
        return row ? toThread(row) : null;
      },
      async list(opts) {
        const rows = listThreads.all(
          opts?.before ?? Number.MAX_SAFE_INTEGER,
          opts?.limit ?? 50,
        ) as ThreadRow[];
        return rows.map(toThread);
      },
      async rename(id, title) {
        mustExist(id);
        renameThread.run(title, Date.now(), id);
      },
      async delete(id) {
        deleteThread.run(id);
      },
      async setAgentSession(id, agentSessionId) {
        mustExist(id);
        setSession.run(agentSessionId, id);
      },
      async appendMessage(threadId, message) {
        const id = message.id ?? randomUUID();
        const now = Date.now();
        appendTx(threadId, message, id, now);
        const base = { id, threadId, createdAt: now };
        return message.role === "user"
          ? { ...base, role: "user", text: message.text }
          : { ...base, role: "assistant", events: message.events };
      },
      async listMessages(threadId, opts) {
        let beforeSeq = Number.MAX_SAFE_INTEGER;
        if (opts?.before) {
          const row = seqOf.get(opts.before, threadId) as { seq: number } | undefined;
          if (row) beforeSeq = row.seq;
        }
        const rows = pageBefore.all(threadId, beforeSeq, opts?.limit ?? 100) as MessageRow[];
        return rows.map(toMessage);
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
