// Client for the reference server: session create + SSE chat stream.
//
// The event and spec types come from the facade package — the browser can't
// run `Analytics` itself (it holds API keys and spawns the agent), but it compiles
// against the same event vocabulary the facade yields. `import type` is
// erased at build time, so no server code reaches the bundle.
import type { ChatEvent } from "@infino-ai/analytics";

export type { ChatEvent };
export type ChartEvent = Extract<ChatEvent, { type: "chart" }>;

export async function createSession(): Promise<string> {
  const res = await fetch("/api/sessions", { method: "POST" });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

// EventSource can't POST, so read the fetch body stream and split SSE frames.
export async function* chat(
  question: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId }),
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
