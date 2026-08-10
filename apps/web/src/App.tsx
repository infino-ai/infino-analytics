import { useEffect, useRef, useState } from "react";
import { chat, createSession, type ChatEvent } from "./api";
import { ChartCard } from "./Chart";

const FALLBACK_SUGGESTIONS = ["What data do I have?", "Show me a trend over time"];

// Step events gain client-side completion state when step_done arrives.
type TurnEvent = ChatEvent & { done?: boolean; ok?: boolean };

interface Turn {
  question: string;
  at: string;
  events: TurnEvent[];
  /** Accumulated text deltas for the in-flight message; replaced by the
   * complete progress/summary block when it arrives. */
  live: string;
  /** Current activity label ("running a query…"); shown while running. */
  status: string;
  running: boolean;
}

// Simple markdown-lite: only **bold**, which the agent uses for key figures.
function rich(text: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function App() {
  const [sessionId, setSessionId] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    createSession().then(setSessionId).catch(() => {});
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then((b: { suggestions?: string[] }) => {
        if (b.suggestions?.length) setSuggestions(b.suggestions);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  function stop() {
    abortRef.current?.abort();
  }

  async function ask(question: string) {
    if (!question.trim() || busy || !sessionId) return;
    setInput("");
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const at = new Date().toTimeString().slice(0, 8);
    setTurns((t) => [
      ...t,
      { question, at, events: [], live: "", status: "analyzing", running: true },
    ]);
    try {
      for await (const event of chat(question, sessionId, abort.signal)) {
        setTurns((t) => {
          const copy = t.slice();
          const turn = { ...copy[copy.length - 1] };
          if (event.type === "status") {
            turn.status = event.text;
          } else if (event.type === "delta") {
            turn.live = turn.live + event.text;
          } else if (event.type === "step_done") {
            // Close the matching trace step in place.
            turn.events = turn.events.map((e) =>
              e.type === "step" && e.id === event.id ? { ...e, done: true, ok: event.ok } : e,
            );
          } else {
            // A complete text block supersedes its accumulated deltas.
            if (event.type === "progress" || event.type === "summary") turn.live = "";
            if (event.type === "step") turn.status = "";
            turn.events = [...turn.events, event];
            if (event.type === "done") turn.running = false;
          }
          copy[copy.length - 1] = turn;
          return copy;
        });
      }
    } catch {
      // Aborted by the stop button — the server cancels the run.
    } finally {
      abortRef.current = null;
      setBusy(false);
      setTurns((t) => {
        const copy = t.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], live: "", running: false };
        return copy;
      });
    }
  }

  // Figures are numbered across the whole session, datasheet-style.
  let figNo = 0;

  return (
    <div className="app">
      <header className="header">
        <span className="wordmark">Fino</span>
        <span className="sub">conversational analytics · infino engine</span>
        <span className="status">{sessionId ? "live" : "connecting"}</span>
      </header>

      <div className="thread" ref={threadRef}>
        {turns.length === 0 && (
          <div className="empty">
            <div className="big">
              Ask your <em>data</em> anything.
            </div>
            <div>answers arrive as figures, tables, and plain language</div>
          </div>
        )}
        {turns.map((turn, i) => {
          const hasSummary = turn.events.some((e) => e.type === "summary");
          const lastProgress = turn.events.reduce(
            (acc, e, j) => (e.type === "progress" ? j : acc),
            -1,
          );
          return (
            <div className="turn" key={i}>
              <div className="rail">
                <span className="qno">Q.{pad(i + 1)}</span>
                <span className="time">{turn.at}</span>
              </div>
              <div className="content">
                <h2 className="q">{turn.question}</h2>
                {turn.events.map((event, j) => {
                  switch (event.type) {
                    case "progress": {
                      const isAnswer = !hasSummary && !turn.running && j === lastProgress;
                      return (
                        <div className={isAnswer ? "summary" : "progress"} key={j}>
                          {rich(event.text)}
                        </div>
                      );
                    }
                    case "step":
                      return (
                        <div className={event.done ? "step done" : "step"} key={j}>
                          <span className="step-mark">
                            {event.done ? (event.ok ? "✓" : "✕") : "▸"}
                          </span>
                          <code className="step-tool">{event.tool}</code>
                          {event.detail && <span className="step-detail">{event.detail}</span>}
                        </div>
                      );
                    case "sql":
                      return (
                        <details className="sqlblock" key={j}>
                          <summary>SQL</summary>
                          <pre>{event.query}</pre>
                        </details>
                      );
                    case "chart":
                      figNo += 1;
                      return <ChartCard event={event} figNo={figNo} key={j} />;
                    case "summary":
                      return <div className="summary" key={j}>{rich(event.text)}</div>;
                    case "error":
                      return <div className="error" key={j}>{event.message}</div>;
                    case "done":
                      return (
                        <div className="meta" key={j}>
                          {event.turns != null && `${event.turns} steps`}
                          {event.costUsd != null && ` · $${event.costUsd.toFixed(3)}`}
                        </div>
                      );
                    default:
                      return null;
                  }
                })}
                {turn.live && <div className="progress">{rich(turn.live)}</div>}
                {turn.running && !turn.live && (
                  <span className="thinking">{turn.status}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="composer">
        {turns.length === 0 && (
          <div className="chips">
            {suggestions.map((s) => (
              <button className="chip" key={s} onClick={() => ask(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          className="inputrow"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <span className="prompt-mark">❯</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="ask about your data…"
            disabled={busy}
          />
          {busy ? (
            <button type="button" className="stop" onClick={stop}>
              STOP
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              ASK →
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
