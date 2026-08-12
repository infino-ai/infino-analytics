// Client for the reference server: thread CRUD + SSE chat stream.
//
// The event and spec types come from the facade package — the browser can't
// run `Analytics` itself (it holds API keys and spawns the agent), but it compiles
// against the same event vocabulary the facade yields. `import type` is
// erased at build time, so no server code reaches the bundle.
import type {
  ChatEvent,
  Dashboard,
  ExecuteResult,
  NewVisualization,
  Thread,
  StoredMessage,
  Visualization,
} from "@infino-ai/analytics";

export type {
  ChatEvent,
  Thread,
  StoredMessage,
  Visualization,
  Dashboard,
  ExecuteResult,
  NewVisualization,
};
export type ChartEvent = Extract<ChatEvent, { type: "chart" }>;

// ── the persistence surface (visualizations + dashboards) ─────────────────

interface Envelope<T> {
  id: string;
  attributes: T;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function listVisualizations(): Promise<Visualization[]> {
  const body = await json<{ items: Envelope<Visualization>[] }>(await fetch("/visualizations"));
  return body.items.map((e) => e.attributes);
}

export async function createVisualization(input: NewVisualization): Promise<Visualization> {
  const res = await fetch("/visualizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<Envelope<Visualization>>(res)).attributes;
}

export async function deleteVisualization(id: string): Promise<void> {
  await fetch(`/visualizations/${id}`, { method: "DELETE" });
}

export async function executeVisualization(
  id: string,
  body: { filters?: unknown; time_range?: unknown } = {},
): Promise<ExecuteResult> {
  const res = await fetch(`/visualizations/${id}/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return json<ExecuteResult>(res);
}

export async function listDashboards(): Promise<Dashboard[]> {
  const body = await json<{ items: Envelope<Dashboard>[] }>(await fetch("/dashboards"));
  return body.items.map((e) => e.attributes);
}

export async function getDashboard(id: string): Promise<Dashboard> {
  return (await json<Envelope<Dashboard>>(await fetch(`/dashboards/${id}`))).attributes;
}

export async function createDashboard(input: { title: string }): Promise<Dashboard> {
  const res = await fetch("/dashboards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<Envelope<Dashboard>>(res)).attributes;
}

export async function patchDashboard(id: string, patch: unknown): Promise<Dashboard> {
  const res = await fetch(`/dashboards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<Envelope<Dashboard>>(res)).attributes;
}

export async function deleteDashboard(id: string): Promise<void> {
  await fetch(`/dashboards/${id}`, { method: "DELETE" });
}

export async function createThread(): Promise<Thread> {
  const res = await fetch("/api/threads", { method: "POST" });
  const body = (await res.json()) as { thread: Thread };
  return body.thread;
}

export async function listThreads(): Promise<Thread[]> {
  const res = await fetch("/api/threads");
  const body = (await res.json()) as { threads: Thread[] };
  return body.threads;
}

export async function getThreadMessages(
  threadId: string,
): Promise<{ thread: Thread; messages: StoredMessage[] }> {
  const res = await fetch(`/api/threads/${threadId}/messages`);
  if (!res.ok) throw new Error(`thread fetch failed (${res.status})`);
  return (await res.json()) as { thread: Thread; messages: StoredMessage[] };
}

export async function deleteThread(threadId: string): Promise<void> {
  await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
}

// EventSource can't POST, so read the fetch body stream and split SSE frames.
export async function* chat(
  question: string,
  threadId: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, threadId }),
    signal,
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `request failed (${res.status})` };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("");
      if (!data) continue;
      try {
        yield JSON.parse(data) as ChatEvent;
      } catch {
        // Skip malformed frames rather than killing the stream.
      }
    }
  }
}
