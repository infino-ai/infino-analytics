// The reference server: the facade exposed over HTTP.
//
//   INFINO_URI=https://<host>/<database> INFINO_API_KEY=... npm run dev -w @infino-ai/analytics-server
//
// Surface:
//   POST   /api/threads               → { thread } (also aliased as POST /api/sessions)
//   GET    /api/threads               → { threads } newest-activity first
//   GET    /api/threads/:id/messages  → { messages } the persisted transcript
//   DELETE /api/threads/:id           → 204
//   POST   /api/chat                  → SSE stream of ChatEvents ({ threadId, question })
//   GET    /*                         → the demo web UI (when built)
//
// The viz/dashboard persistence routes (parity API) land in the next phase.
// One process on purpose: it splits into a standalone deployable when that
// API arrives.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Analytics } from "@infino-ai/analytics";
import { SqliteStorage } from "@infino-ai/analytics-storage-sqlite";
import { InfinoStorage } from "@infino-ai/analytics-storage-infino";

const PORT = Number(process.env.PORT ?? 8787);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return v;
}

// The storage seam, wired: these lines decide where threads live. Swap in
// any other StorageAdapter (your own database) without touching anything
// below. FINO_STORAGE=infino keeps threads in the Infino database itself
// (no second datastore); the default is a local SQLite file.
const storage =
  process.env.FINO_STORAGE === "infino"
    ? new InfinoStorage({ uri: requireEnv("INFINO_URI") })
    : new SqliteStorage({ path: process.env.FINO_DB ?? "./data/analytics.db" });

const analytics = new Analytics({
  infino: { uri: requireEnv("INFINO_URI") },
  llm: { model: process.env.FINO_MODEL },
  storage,
});

const app = new Hono();

app.post("/api/threads", async (c) => c.json({ thread: await analytics.threads.create() }));
// Alias kept for the original session-flavored surface.
app.post("/api/sessions", async (c) =>
  c.json({ sessionId: (await analytics.threads.create()).id }),
);

app.get("/api/threads", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const before = c.req.query("before");
  return c.json({
    threads: await analytics.threads.list({ limit, before: before ? Number(before) : undefined }),
  });
});

app.get("/api/threads/:id/messages", async (c) => {
  const thread = await analytics.threads.get(c.req.param("id"));
  if (!thread) return c.json({ error: "unknown thread" }, 404);
  const limit = Number(c.req.query("limit") ?? 100);
  const before = c.req.query("before");
  return c.json({
    thread,
    messages: await analytics.threads.listMessages(thread.id, { limit, before }),
  });
});

app.delete("/api/threads/:id", async (c) => {
  await analytics.threads.delete(c.req.param("id"));
  return c.body(null, 204);
});

// Suggestion chips for the demo UI. Deployment-specific: set FINO_SUGGESTIONS
// to pipe-separated questions that fit the loaded data; the defaults work on
// any dataset.
const DEFAULT_SUGGESTIONS = [
  "What data do I have?",
  "Show me a trend over time",
  "What stands out in this data?",
];
app.get("/api/suggestions", (c) => {
  const fromEnv = process.env.FINO_SUGGESTIONS?.split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return c.json({ suggestions: fromEnv?.length ? fromEnv : DEFAULT_SUGGESTIONS });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ question?: string; threadId?: string; sessionId?: string }>();
  const question = body.question?.trim();
  if (!question) return c.json({ error: "question is required" }, 400);
  // sessionId accepted as the legacy spelling of threadId.
  const threadId = body.threadId ?? body.sessionId;

  const abort = new AbortController();
  // Client disconnect (tab closed, stop button) cancels the run.
  c.req.raw.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        // The signal reaches the agent harness: a client disconnect stops
        // the model run itself, not just this stream.
        for await (const event of analytics.ask(question, {
          threadId,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) break;
          send(event);
        }
      } catch (err) {
        // Sanitized: message only, never a stack trace.
        send({ type: "error", message: err instanceof Error ? err.message : "internal error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// Static demo UI (built by apps/web). Falls back to a pointer message in dev.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "..", "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

app.get("/*", (c) => {
  if (!existsSync(webDist)) {
    return c.text("demo UI not built — run: npm run build -w @infino-ai/analytics-web", 200);
  }
  const path = c.req.path === "/" ? "/index.html" : c.req.path;
  const file = join(webDist, path.replace(/\.\./g, ""));
  if (!existsSync(file)) {
    const index = join(webDist, "index.html");
    return c.body(readFileSync(index), 200, { "Content-Type": "text/html" });
  }
  return c.body(readFileSync(file), 200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
  });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`analytics server on http://localhost:${PORT}`);
});
