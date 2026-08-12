import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chat,
  createThread,
  deleteThread,
  getThreadMessages,
  listThreads,
  type ChatEvent,
  type StoredMessage,
  type Thread,
} from "./api";
import { ChartCard } from "./Chart";
import { Check, Chevron, Cross, FinoMark, Spinner, ToolIcon } from "./icons";

const FALLBACK_SUGGESTIONS = ["What data do I have?", "Show me a trend over time"];

// The agent replies in GitHub-flavored markdown (headings, lists, tables,
// bold). Render to React elements — no dangerouslySetInnerHTML — so model
// output can never inject HTML.
function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// The SQL behind a figure, tucked behind a disclosure: the result is the
// first-class thing; what ran is one click away.
function SqlReveal({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className={open ? "sqlblock open" : "sqlblock"}>
      <figcaption>
        <button className="sqlhead" onClick={() => setOpen(!open)}>
          <Chevron className="caret" open={open} />
          SQL
        </button>
        {open && <CopyButton text={sql} />}
      </figcaption>
      <div className="sqlwrap">
        <div className="sqlinner">
          <pre>
            <code>{sql}</code>
          </pre>
        </div>
      </div>
    </figure>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

// Step events gain client-side completion state when step_done arrives.
type TurnEvent = ChatEvent & { done?: boolean; ok?: boolean };

interface Turn {
  id: number;
  question: string;
  startedAt: number;
  elapsed?: number;
  events: TurnEvent[];
  /** Accumulated streaming text for the forming answer. */
  live: string;
  /** Current activity label ("running a query…"). */
  status: string;
  running: boolean;
  /** Whether the process/activity block is expanded. Auto-collapses on done. */
  activityOpen: boolean;
}

let turnCounter = 0;

// Rebuild display turns from a persisted transcript: pair each user message
// with the assistant message that follows it, and replay step_done events
// onto their steps the same way the live stream does. Elapsed time falls out
// of the stored timestamps.
function turnsFromMessages(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      turns.push({
        id: turnCounter++,
        question: msg.text,
        startedAt: msg.createdAt,
        events: [],
        live: "",
        status: "",
        running: false,
        activityOpen: false,
      });
    } else {
      const turn = turns[turns.length - 1];
      if (!turn) continue;
      const events: TurnEvent[] = [];
      for (const e of msg.events) {
        if (e.type === "step_done") {
          const step = events.find((s) => s.type === "step" && s.id === e.id);
          if (step) Object.assign(step, { done: true, ok: e.ok });
        } else {
          events.push(e.type === "step" ? { ...e } : e);
        }
      }
      turn.events = events;
      turn.elapsed = (msg.createdAt - turn.startedAt) / 1000;
    }
  }
  return turns;
}

export default function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  // null = a fresh, not-yet-created thread; it materializes on the first ask
  // so reloading the page never litters the sidebar with empty threads.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Stick to bottom only while the user is already there — don't yank them
  // down if they've scrolled up to read.
  const stickRef = useRef(true);

  const refreshThreads = () => listThreads().then(setThreads).catch(() => {});

  useEffect(() => {
    refreshThreads();
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then((b: { suggestions?: string[] }) => {
        if (b.suggestions?.length) setSuggestions(b.suggestions);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function toggleActivity(id: number) {
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, activityOpen: !x.activityOpen } : x)));
  }

  function stop() {
    abortRef.current?.abort();
  }

  function growTextarea() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }

  function newThread() {
    if (busy) return;
    setActiveId(null);
    setTurns([]);
  }

  async function openThread(id: string) {
    if (busy || id === activeId) return;
    try {
      const { messages } = await getThreadMessages(id);
      setActiveId(id);
      setTurns(turnsFromMessages(messages));
      stickRef.current = true;
    } catch {
      refreshThreads(); // it may have been deleted elsewhere
    }
  }

  async function removeThread(id: string) {
    if (busy) return;
    await deleteThread(id).catch(() => {});
    if (id === activeId) newThread();
    refreshThreads();
  }

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    requestAnimationFrame(growTextarea);
    setBusy(true);
    stickRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    const startedAt = Date.now();
    setTurns((t) => [
      ...t,
      {
        id: turnCounter++,
        question,
        startedAt,
        events: [],
        live: "",
        status: "analyzing",
        running: true,
        activityOpen: true,
      },
    ]);
    try {
      // The thread materializes on first use.
      let threadId = activeId;
      if (!threadId) {
        threadId = (await createThread()).id;
        setActiveId(threadId);
      }
      for await (const event of chat(question, threadId, abort.signal)) {
        setTurns((t) => {
          const copy = t.slice();
          const turn = { ...copy[copy.length - 1] };
          if (event.type === "status") {
            turn.status = event.text;
          } else if (event.type === "delta") {
            turn.live = turn.live + event.text;
          } else if (event.type === "step_done") {
            turn.events = turn.events.map((e) =>
              e.type === "step" && e.id === event.id ? { ...e, done: true, ok: event.ok } : e,
            );
          } else {
            if (event.type === "progress" || event.type === "summary") turn.live = "";
            if (event.type === "step") turn.status = "";
            turn.events = [...turn.events, event];
            if (event.type === "done") {
              turn.running = false;
              turn.activityOpen = false; // tidy up once the answer has landed
              turn.elapsed = (Date.now() - turn.startedAt) / 1000;
            }
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
        const last = { ...copy[copy.length - 1], live: "", running: false, activityOpen: false };
        copy[copy.length - 1] = last;
        return copy;
      });
      refreshThreads(); // pick up the auto-set title and new ordering
    }
  }

  let figNo = 0;

  return (
    <div className="app">
      <header className="header">
        <span className="mark">
          <FinoMark />
        </span>
        <span className="wordmark">Fino</span>
        <span className="sub">conversational analytics · infino engine</span>
        <span className="status">live</span>
      </header>

      <div className="body">
        <aside className="sidebar">
          <button className="newthread" onClick={newThread} disabled={busy}>
            + new thread
          </button>
          <nav className="threadlist">
            {threads.map((t) => (
              <div className={t.id === activeId ? "threaditem active" : "threaditem"} key={t.id}>
                <button
                  className="threadopen"
                  onClick={() => openThread(t.id)}
                  disabled={busy}
                  title={t.title}
                >
                  {t.title || "untitled"}
                </button>
                <button
                  className="threadkill"
                  onClick={() => removeThread(t.id)}
                  disabled={busy}
                  title="delete thread"
                >
                  ×
                </button>
              </div>
            ))}
            {threads.length === 0 && <div className="threadempty">no threads yet</div>}
          </nav>
        </aside>

        <main className="main">
          <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
            {turns.length === 0 && (
              <div className="empty">
                <div className="big">
                  Ask your <em>data</em> anything.
                </div>
                <div>answers arrive as figures, tables, and plain language</div>
              </div>
            )}

            {turns.map((turn) => {
              // Partition the event stream into process (tucked into the
              // activity block), figures (always visible), and the answer.
              const steps = turn.events.filter((e) => e.type === "step") as Extract<
                TurnEvent,
                { type: "step" }
              >[];
              const summary = [...turn.events].reverse().find((e) => e.type === "summary") as
                | Extract<TurnEvent, { type: "summary" }>
                | undefined;
              const errors = turn.events.filter((e) => e.type === "error") as Extract<
                TurnEvent,
                { type: "error" }
              >[];

              // The headline answer only exists once the turn is done: it's
              // the summary, or (absent one) the LAST assistant text block.
              // Its event index is excluded from the activity log so it
              // isn't shown twice. While the turn is running, nothing is the
              // "answer" yet — every narration line is the model thinking
              // out loud, and belongs in the working log.
              let answerIdx = -1;
              if (!turn.running) {
                if (summary) {
                  answerIdx = turn.events.lastIndexOf(summary);
                } else {
                  for (let k = turn.events.length - 1; k >= 0; k--) {
                    if (turn.events[k].type === "progress") {
                      answerIdx = k;
                      break;
                    }
                  }
                }
              }
              const answerText =
                answerIdx >= 0 ? (turn.events[answerIdx] as { text: string }).text : "";

              // Pair each chart with the SQL emitted just before it.
              const figures: { sql?: string; chart: Extract<TurnEvent, { type: "chart" }> }[] = [];
              let pendingSql: string | undefined;
              for (const e of turn.events) {
                if (e.type === "sql") pendingSql = e.query;
                else if (e.type === "chart") {
                  figures.push({ sql: pendingSql, chart: e });
                  pendingSql = undefined;
                }
              }

              // The working log = narration + tool steps, in the order they
              // happened, minus whichever text block became the answer.
              const logItems = turn.events
                .map((e, k) => ({ e, k }))
                .filter(
                  ({ e, k }) => (e.type === "progress" && k !== answerIdx) || e.type === "step",
                );

              const open = turn.running || turn.activityOpen;
              const hasActivity = logItems.length > 0 || turn.running;

              return (
                <div className="turn" key={turn.id}>
                  <div className="user-row">
                    <div className="user-bubble">{turn.question}</div>
                  </div>

                  <div className="assistant">
                    {hasActivity && (
                      <div className={open ? "activity open" : "activity"}>
                        <button className="activity-head" onClick={() => toggleActivity(turn.id)}>
                          <Chevron className="caret" open={open} />
                          {turn.running ? (
                            <span className="working">
                              <Spinner className="working-spin" />
                              {turn.status || "working"}
                            </span>
                          ) : (
                            <span className="worked">{steps.length} steps</span>
                          )}
                        </button>
                        <div className="activity-wrap">
                          <div className="activity-body">
                            {logItems.map(({ e, k }) =>
                              e.type === "step" ? (
                                <div
                                  className={
                                    "step " + (!e.done ? "running" : e.ok ? "done" : "failed")
                                  }
                                  key={`s${e.id}`}
                                >
                                  <span className="step-mark">
                                    {!e.done ? <Spinner /> : e.ok ? <Check /> : <Cross />}
                                  </span>
                                  <span className="step-ico">
                                    <ToolIcon tool={e.tool} />
                                  </span>
                                  <code className="step-tool">{e.tool}</code>
                                  {e.detail && <span className="step-detail">{e.detail}</span>}
                                </div>
                              ) : (
                                <div className="narration" key={`n${k}`}>
                                  <Md text={(e as { text: string }).text} />
                                </div>
                              ),
                            )}
                            {turn.running && turn.live && (
                              <div className="narration">
                                <Md text={turn.live} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {figures.map(({ sql, chart }) => {
                      figNo += 1;
                      return (
                        <div key={`fig${figNo}`}>
                          <ChartCard event={chart} />
                          {sql && <SqlReveal sql={sql} />}
                        </div>
                      );
                    })}

                    {errors.map((e, k) => (
                      <div className="error" key={`e${k}`}>
                        {e.message}
                      </div>
                    ))}

                    {answerText && (
                      <div className="answer">
                        <Md text={answerText} />
                        <CopyButton text={answerText} />
                      </div>
                    )}

                    {!turn.running && turn.elapsed !== undefined && (
                      <div className="turn-time">{turn.elapsed.toFixed(1)}s</div>
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
              <textarea
                ref={taRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  growTextarea();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(input);
                  }
                }}
                placeholder="ask about your data…    (Shift+Enter for a new line)"
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
        </main>
      </div>
    </div>
  );
}
