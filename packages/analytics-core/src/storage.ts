import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./events.js";

// The storage seam. Consumers (the facade, the HTTP server) type against
// this interface only — swapping databases means constructing a different
// adapter and passing it in, never touching consumer code. All methods are
// async so implementations backed by a network database (Postgres, etc.)
// fit without an interface change, even though the SQLite default is
// synchronous underneath.

export interface Thread {
  id: string;
  title: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms; bumped on every message append and rename */
  updatedAt: number;
  /** Agent-harness conversation pointer (opaque here): lets a reopened
   * thread resume with the model's context. May be absent — the thread
   * still renders from its transcript; the conversation restarts fresh. */
  agentSessionId?: string;
}

/** A persisted turn. User turns store the question text; assistant turns
 * store the full persistent event list — exactly what was shown, including
 * chart specs and their result rows, so history re-renders without
 * re-querying (numbers don't drift, deleted tables don't break old
 * threads). Transient events (status, delta) are never persisted. */
export type StoredMessage =
  | { id: string; threadId: string; role: "user"; createdAt: number; text: string }
  | { id: string; threadId: string; role: "assistant"; createdAt: number; events: ChatEvent[] };

export type NewMessage =
  | { id?: string; role: "user"; text: string }
  | { id?: string; role: "assistant"; events: ChatEvent[] };

export interface ThreadStore {
  create(opts?: { id?: string; title?: string }): Promise<Thread>;
  get(id: string): Promise<Thread | null>;
  /** Newest activity first. `before` pages by updatedAt (exclusive). */
  list(opts?: { limit?: number; before?: number }): Promise<Thread[]>;
  rename(id: string, title: string): Promise<void>;
  /** Deletes the thread and its messages. */
  delete(id: string): Promise<void>;
  setAgentSession(id: string, agentSessionId: string): Promise<void>;
  /** Message ids may be client-supplied (idempotent writes); generated when
   * absent. Appending bumps the thread's updatedAt. */
  appendMessage(threadId: string, message: NewMessage): Promise<StoredMessage>;
  /** Chronological (oldest first). `before` pages backwards from a message
   * id (exclusive): the newest `limit` messages older than it. */
  listMessages(
    threadId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]>;
}

export interface StorageAdapter {
  threads: ThreadStore;
  /** Visualization/dashboard stores join this interface with the
   * persistence API; the adapter object is shared across all surfaces. */
  close?(): void | Promise<void>;
}

/** Event types worth persisting — the durable record of a turn. status and
 * delta are transient by contract (superseded within the same turn). */
export function isPersistentEvent(event: ChatEvent): boolean {
  return event.type !== "status" && event.type !== "delta";
}

// ── In-memory reference implementation ─────────────────────────────────────
// Zero dependencies; the default when no adapter is passed. Suits tests and
// throwaway runs — nothing survives a restart. It is also the smallest
// worked example of the interface for anyone writing their own adapter.

export class InMemoryStorage implements StorageAdapter {
  readonly threads: ThreadStore;

  constructor() {
    const threads = new Map<string, Thread>();
    const messages = new Map<string, StoredMessage[]>();

    const mustGet = (id: string): Thread => {
      const t = threads.get(id);
      if (!t) throw new Error(`unknown thread: ${id}`);
      return t;
    };

    this.threads = {
      async create(opts) {
        const now = Date.now();
        const thread: Thread = {
          id: opts?.id ?? randomUUID(),
          title: opts?.title ?? "",
          createdAt: now,
          updatedAt: now,
        };
        threads.set(thread.id, thread);
        messages.set(thread.id, []);
        return { ...thread };
      },
      async get(id) {
        const t = threads.get(id);
        return t ? { ...t } : null;
      },
      async list(opts) {
        const limit = opts?.limit ?? 50;
        return [...threads.values()]
          .filter((t) => (opts?.before === undefined ? true : t.updatedAt < opts.before))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit)
          .map((t) => ({ ...t }));
      },
      async rename(id, title) {
        const t = mustGet(id);
        t.title = title;
        t.updatedAt = Date.now();
      },
      async delete(id) {
        threads.delete(id);
        messages.delete(id);
      },
      async setAgentSession(id, agentSessionId) {
        mustGet(id).agentSessionId = agentSessionId;
      },
      async appendMessage(threadId, message) {
        const t = mustGet(threadId);
        const stored = {
          ...message,
          id: message.id ?? randomUUID(),
          threadId,
          createdAt: Date.now(),
        } as StoredMessage;
        messages.get(threadId)?.push(stored);
        t.updatedAt = stored.createdAt;
        return stored;
      },
      async listMessages(threadId, opts) {
        const all = messages.get(threadId) ?? [];
        const upTo = opts?.before ? all.findIndex((m) => m.id === opts.before) : all.length;
        const end = upTo === -1 ? all.length : upTo;
        const limit = opts?.limit ?? 100;
        return all.slice(Math.max(0, end - limit), end);
      },
    };
  }
}
