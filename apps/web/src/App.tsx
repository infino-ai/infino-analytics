import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chat, createSession, type ChatEvent } from "./api";
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

export default function App() {
  const [sessionId, setSessionId] = useState<string>();
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

  async function ask(question: string) {
    if (!question.trim() || busy || !sessionId) return;
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
      for await (const event of chat(question, sessionId, abort.signal)) {
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
        <span className="status">{sessionId ? "live" : "connecting"}</span>
      </header>

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
          // Partition the event stream into process (tucked into the activity
          // block), figures (always visible), and the final answer.
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

          // The headline answer only exists once the turn is done: it's the
          // summary, or (absent one) the LAST assistant text block. Its event
          // index is excluded from the activity log so it isn't shown twice.
          // While the turn is running, nothing is the "answer" yet — every
          // narration line is just the model thinking out loud, and belongs
          // in the working log, not floating below it.
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
          const answerText = answerIdx >= 0 ? (turn.events[answerIdx] as { text: string }).text : "";

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
          // happened, minus whichever text block became the headline answer.
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
                        <span className="worked">
                          Worked for {turn.elapsed?.toFixed(1)}s · {steps.length} steps
                        </span>
                      )}
                    </button>
                    {open && (
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
                    )}
                  </div>
                )}

                {figures.map(({ sql, chart }) => {
                  figNo += 1;
                  return (
                    <div key={`fig${figNo}`}>
                      <ChartCard event={chart} figNo={figNo} />
                      {sql && (
                        <figure className="sqlblock">
                          <figcaption>
                            SQL
                            <CopyButton text={sql} />
                          </figcaption>
                          <pre>
                            <code>{sql}</code>
                          </pre>
                        </figure>
                      )}
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
    </div>
  );
}
