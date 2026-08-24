// The reference server: the facade exposed over HTTP.
//
//   INFINO_URI=https://<host>/<database> INFINO_API_KEY=... npm run dev -w @infino-ai/analytics-server
//
// Chat surface:
//   POST   /api/threads               → { thread } (also aliased as POST /api/sessions)
//   GET    /api/threads               → { threads } newest-activity first
//   GET    /api/threads/:id/messages  → { messages } the persisted transcript
//   DELETE /api/threads/:id           → 204
//   POST   /api/chat                  → SSE stream of ChatEvents ({ threadId, question })
//   GET    /*                         → the demo web UI (when built)
//
// Persistence surface (REST with envelope responses
// { id, kind, created_at, updated_at, attributes }):
//   GET    /visualizations            list; ?ids=a,b serves fetch-many
//   POST   /visualizations            lenient create (server fills defaults)
//   PUT    /visualizations/:id        strict full-shape upsert
//   PATCH  /visualizations/:id        RFC 7396 merge patch
//   GET    /visualizations/:id
//   DELETE /visualizations/:id
//   POST   /visualizations/:id/data   execute; id "_execute" runs the inline
//                                     body.visualization without persisting
//   GET/POST /dashboards, PUT/PATCH/GET/DELETE /dashboards/:id
//   (deliberately no POST /dashboards/:id/data — clients fan out one
//   execute per panel with merged filters; layout and rendering are theirs)
//
// No auth on purpose: this is a reference server; put your gateway's
// authn/z in front (or add middleware here) before exposing it.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Analytics, type AgentHarness } from "@infino-ai/analytics";
import { SqliteStorage } from "@infino-ai/analytics-storage-sqlite";

const PORT = Number(process.env.PORT ?? 8787);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return v;
}

// The storage seam, wired: this line decides where app state lives. Swap
// in your own StorageAdapter (your database) without touching anything
// below; the reference implementation is a local SQLite file.
const storage = new SqliteStorage({ path: process.env.FINO_DB ?? "./data/analytics.db" });

// The LLM seam, wired: the app picks the harness, so the facade keeps only
// its Claude default and never pulls a second provider's SDK. Imports are
// dynamic so an unselected harness costs nothing at boot — adding one is a
// single entry here.
const INFINO_URI = requireEnv("INFINO_URI");

// Dataset notes are harness-agnostic: whichever one runs, it gets them.
const DOMAIN_CONTEXT = process.env.FINO_DOMAIN_CONTEXT;

const HARNESSES: Record<string, () => Promise<AgentHarness>> = {
  openai: async () =>
    (await import("@infino-ai/analytics-agent-openai")).createOpenAIHarness({
      infino: { uri: INFINO_URI },
      domainContext: DOMAIN_CONTEXT,
    }),
};

const selected = process.env.FINO_HARNESS;
if (selected && !(selected in HARNESSES)) {
  console.error(`FINO_HARNESS=${selected} is unknown (have: ${Object.keys(HARNESSES).join(", ")})`);
  process.exit(1);
}
// Unselected → undefined → the facade's built-in default.
const harness = selected ? await HARNESSES[selected]() : undefined;

// llm tunes the built-in default; a selected harness replaces it. Passing
// both is rejected, so send exactly one.
const analytics = new Analytics({
  infino: { uri: INFINO_URI },
  ...(harness
    ? { harness }
    : { llm: { model: process.env.FINO_MODEL }, domainContext: DOMAIN_CONTEXT }),
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
  // sessionId accepted as an older spelling of threadId.
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

// ── the persistence surface: visualizations + dashboards ──────────────────

type Enveloped = { id: string; created_at: string; updated_at: string };
const envelope = (kind: "visualization" | "dashboard", doc: Enveloped) => ({
  id: doc.id,
  kind,
  created_at: doc.created_at,
  updated_at: doc.updated_at,
  attributes: doc,
});

// Facade errors carry meaning in their message; map them to status codes at
// the HTTP boundary.
function errStatus(err: unknown): 400 | 404 {
  return err instanceof Error && err.message.startsWith("unknown") ? 404 : 400;
}
const errBody = (err: unknown) => ({
  error: err instanceof Error ? err.message.slice(0, 500) : "bad request",
});

function listParams(c: { req: { query: (k: string) => string | undefined } }) {
  const ids = c.req.query("ids");
  return {
    ids: ids ? ids.split(",").filter(Boolean) : undefined,
    limit: Math.min(Number(c.req.query("limit") ?? 500), 1000),
    offset: Number(c.req.query("offset") ?? 0),
  };
}

app.get("/visualizations", async (c) => {
  const items = await analytics.visualizations.list(listParams(c));
  return c.json({ items: items.map((v) => envelope("visualization", v)) });
});

app.post("/visualizations", async (c) => {
  try {
    const doc = await analytics.visualizations.create(await c.req.json());
    return c.json(envelope("visualization", doc), 201);
  } catch (err) {
    return c.json(errBody(err), 400);
  }
});

app.get("/visualizations/:id", async (c) => {
  const doc = await analytics.visualizations.get(c.req.param("id"));
  if (!doc) return c.json({ error: "unknown visualization" }, 404);
  return c.json(envelope("visualization", doc));
});

app.put("/visualizations/:id", async (c) => {
  try {
    const doc = await analytics.visualizations.put(c.req.param("id"), await c.req.json());
    return c.json(envelope("visualization", doc));
  } catch (err) {
    return c.json(errBody(err), 400);
  }
});

app.patch("/visualizations/:id", async (c) => {
  try {
    const doc = await analytics.visualizations.update(c.req.param("id"), await c.req.json());
    return c.json(envelope("visualization", doc));
  } catch (err) {
    return c.json(errBody(err), errStatus(err));
  }
});

app.delete("/visualizations/:id", async (c) => {
  await analytics.visualizations.delete(c.req.param("id"));
  return c.body(null, 204);
});

// Execute: runtime filters + time range injected into the SQL. The reserved
// id "_execute" runs the inline body.visualization without persisting it.
app.post("/visualizations/:id/data", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    filters?: unknown;
    time_range?: unknown;
    visualization?: unknown;
  }>().catch(() => ({}) as Record<string, never>);
  try {
    const target =
      id === "_execute"
        ? (body.visualization as Parameters<typeof analytics.visualizations.execute>[0])
        : id;
    if (id === "_execute" && !body.visualization) {
      return c.json({ error: "_execute needs body.visualization" }, 400);
    }
    const result = await analytics.visualizations.execute(target, {
      filters: body.filters as never,
      timeRange: body.time_range as never,
    });
    return c.json(result);
  } catch (err) {
    return c.json(errBody(err), errStatus(err));
  }
});

app.get("/dashboards", async (c) => {
  const items = await analytics.dashboards.list(listParams(c));
  return c.json({ items: items.map((d) => envelope("dashboard", d)) });
});

app.post("/dashboards", async (c) => {
  try {
    const doc = await analytics.dashboards.create(await c.req.json());
    return c.json(envelope("dashboard", doc), 201);
  } catch (err) {
    return c.json(errBody(err), 400);
  }
});

app.get("/dashboards/:id", async (c) => {
  const doc = await analytics.dashboards.get(c.req.param("id"));
  if (!doc) return c.json({ error: "unknown dashboard" }, 404);
  return c.json(envelope("dashboard", doc));
});

app.put("/dashboards/:id", async (c) => {
  try {
    const doc = await analytics.dashboards.put(c.req.param("id"), await c.req.json());
    return c.json(envelope("dashboard", doc));
  } catch (err) {
    return c.json(errBody(err), 400);
  }
});

app.patch("/dashboards/:id", async (c) => {
  try {
    const doc = await analytics.dashboards.update(c.req.param("id"), await c.req.json());
    return c.json(envelope("dashboard", doc));
  } catch (err) {
    return c.json(errBody(err), errStatus(err));
  }
});

app.delete("/dashboards/:id", async (c) => {
  await analytics.dashboards.delete(c.req.param("id"));
  return c.body(null, 204);
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
