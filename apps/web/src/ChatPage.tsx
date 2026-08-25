import { useEffect, useRef, useState } from "react";
import {
  chat,
  createDashboard,
  createThread,
  createVisualization,
  deleteThread,
  getThreadMessages,
  listDashboards,
  listThreads,
  patchDashboard,
  type ChatEvent,
  type Dashboard,
  type StoredMessage,
  type Thread,
} from "./api";
import { ChartCard } from "./Chart";
import { Check, Chevron, Cross, Spinner, ToolIcon } from "./icons";
import { CopyButton, Md } from "./ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

const FALLBACK_SUGGESTIONS = ["What data do I have?", "Show me a trend over time"];

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

// Add a chart from the conversation straight onto a dashboard: pick an
// existing one from the menu or create a new one inline. Under the hood the
// chart's spec is saved as a visualization (it IS the persistence shape)
// and a panel referencing it is appended, auto-flowed two-up on the
// 48-column grid.
function AddToDashboard({ spec }: { spec: Extract<ChatEvent, { type: "chart" }>["spec"] }) {
  const [open, setOpen] = useState(false);
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [addedTo, setAddedTo] = useState("");

  function onOpenChange(next: boolean) {
    if (state === "busy") return;
    setOpen(next);
    if (next) {
      setDashboards(null);
      setNaming(false);
      setTitle("");
      listDashboards().then(setDashboards).catch(() => setDashboards([]));
    }
  }

  async function addTo(dash: Dashboard) {
    setState("busy");
    try {
      const viz = await createVisualization({ ...spec });
      const n = dash.panels.length;
      await patchDashboard(dash.id, {
        panels: [
          ...dash.panels,
          {
            kind: "visualization" as const,
            viz_id: viz.id,
            layout: { x: (n % 2) * 24, y: Math.floor(n / 2) * 18, w: 24, h: 18 },
          },
        ],
      });
      setAddedTo(dash.title);
      setState("done");
      setOpen(false);
    } catch {
      setState("idle");
    }
  }

  async function createAndAdd() {
    if (!title.trim()) return;
    setState("busy");
    try {
      await addTo(await createDashboard({ title: title.trim() }));
    } catch {
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <span className="cardaction added" title={`Added to "${addedTo}"`}>
        ✓ {addedTo}
      </span>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" className="ml-3 font-mono normal-case tracking-normal" disabled={state === "busy"}>
          {state === "busy" ? "Adding…" : "Add to dashboard"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60 font-mono">
        {dashboards === null && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
        {dashboards?.map((d) => (
          <DropdownMenuItem key={d.id} onSelect={() => void addTo(d)}>
            <span className="flex-1 truncate">{d.title}</span>
            <span className="text-[10px] text-muted-foreground">
              {d.panels.length} panel{d.panels.length === 1 ? "" : "s"}
            </span>
          </DropdownMenuItem>
        ))}
        {dashboards?.length === 0 && <DropdownMenuItem disabled>No dashboards yet</DropdownMenuItem>}
        <DropdownMenuSeparator />
        {naming ? (
          <form
            className="flex gap-1.5 p-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void createAndAdd();
            }}
          >
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              // Radix menus grab keystrokes for typeahead; the title field
              // keeps its own.
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Dashboard title"
              className="h-7 font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={!title.trim()}>
              Create
            </Button>
          </form>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setNaming(true);
            }}
          >
            + New dashboard…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Step events gain client-side completion state when step_done arrives.
// `output` is step_done.result; named apart because the chart event owns `result`.
type TurnEvent = ChatEvent & { done?: boolean; ok?: boolean; output?: string };
type StepEvent = Extract<TurnEvent, { type: "step" }>;

// Tool results are usually JSON (schemas, search hits, the chart receipt);
// show them indented when they parse, verbatim otherwise.
function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// A tool call, inline in the narrative where it happened: a quiet chip with
// the tool name, expandable to read the request it ran with and the response
// it got back (the error text when it failed).
function StepChip({ step }: { step: StepEvent }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(step.detail || step.output);
  const state = !step.done ? "running" : step.ok ? "done" : "failed";
  return (
    <div className={`stepchip ${state}${open ? " open" : ""}`}>
      <button
        className="stepchip-head"
        onClick={() => expandable && setOpen(!open)}
        disabled={!expandable}
      >
        <span className="step-mark">
          {!step.done ? <Spinner /> : step.ok ? <Check /> : <Cross />}
        </span>
        <span className="step-ico">
          <ToolIcon tool={step.tool} />
        </span>
        <code className="step-tool">{step.tool}</code>
        {expandable && <Chevron className="caret" open={open} />}
      </button>
      {expandable && (
        <div className="stepchip-wrap">
          <div className="stepchip-inner">
            {step.detail && (
              <>
                <div className="stepchip-label">Request</div>
                <pre>
                  <code>{step.detail}</code>
                </pre>
              </>
            )}
            {step.output && (
              <>
                <div className="stepchip-label">{step.ok === false ? "Error" : "Response"}</div>
                <pre className={step.ok === false ? "failed" : undefined}>
                  <code>{prettify(step.output)}</code>
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface Turn {
  id: number;
  question: string;
  startedAt: number;
  elapsed?: number;
  events: TurnEvent[];
  /** Accumulated streaming text for the forming block. */
  live: string;
  /** Current activity label ("thinking") for the working line. */
  status: string;
  running: boolean;
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
      });
    } else {
      const turn = turns[turns.length - 1];
      if (!turn) continue;
      const events: TurnEvent[] = [];
      for (const e of msg.events) {
        if (e.type === "step_done") {
          const step = events.find((s) => s.type === "step" && s.id === e.id);
          if (step) Object.assign(step, { done: true, ok: e.ok, output: e.result });
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

// The turn body, one chronological flow: narration is first-class prose,
// each tool call sits inline where it happened as an expandable chip,
// charts render where they arrived (their SQL one click deep), and the
// last text block is simply the end of the narrative — nothing relocates
// when the turn finishes.
function TurnBody({ turn }: { turn: Turn }) {
  // Index of the final text block (for the copy affordance).
  let lastTextIdx = -1;
  if (!turn.running) {
    for (let k = turn.events.length - 1; k >= 0; k--) {
      const t = turn.events[k].type;
      if (t === "summary" || t === "progress") {
        lastTextIdx = k;
        break;
      }
    }
  }

  const blocks: React.ReactNode[] = [];
  let pendingSql: string | undefined;
  turn.events.forEach((e, k) => {
    switch (e.type) {
      case "progress":
      case "summary":
        blocks.push(
          <div className="prose" key={k}>
            <Md text={e.text} />
            {k === lastTextIdx && <CopyButton text={e.text} />}
          </div>,
        );
        break;
      case "step":
        blocks.push(<StepChip step={e} key={`s${e.id}`} />);
        break;
      case "sql":
        pendingSql = e.query; // attaches to the chart that follows
        break;
      case "chart":
        blocks.push(
          <div key={k}>
            <ChartCard event={e} actions={<AddToDashboard spec={e.spec} />} />
            {pendingSql && <SqlReveal sql={pendingSql} />}
          </div>,
        );
        pendingSql = undefined;
        break;
      case "error":
        blocks.push(
          <div className="error" key={k}>
            {e.message}
          </div>,
        );
        break;
      default:
        break;
    }
  });

  return (
    <div className="assistant">
      {blocks}
      {turn.running && turn.live && (
        <div className="prose">
          <Md text={turn.live} />
        </div>
      )}
      {turn.running && (
        <div className="working-line">
          <Spinner className="working-spin" />
          {turn.status || "working"}
        </div>
      )}
      {!turn.running && turn.elapsed !== undefined && (
        <div className="turn-time">{turn.elapsed.toFixed(1)}s</div>
      )}
    </div>
  );
}

export default function ChatPage() {
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
              e.type === "step" && e.id === event.id
                ? { ...e, done: true, ok: event.ok, output: event.result }
                : e,
            );
          } else {
            // The complete text block supersedes its streamed deltas; a new
            // step means the model has moved on from writing.
            if (event.type === "progress" || event.type === "summary") turn.live = "";
            if (event.type === "step") {
              turn.live = "";
              turn.status = "";
            }
            turn.events = [...turn.events, event];
            if (event.type === "done") {
              turn.running = false;
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
        const last = { ...copy[copy.length - 1], live: "", running: false };
        copy[copy.length - 1] = last;
        return copy;
      });
      refreshThreads(); // pick up the auto-set title and new ordering
    }
  }

  return (
    <div className="body">
      <aside className="sidebar">
        <Button
          variant="outline"
          size="sm"
          className="mr-2.5 justify-start font-mono normal-case tracking-normal"
          onClick={newThread}
          disabled={busy}
        >
          + New
        </Button>
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
                title="delete"
              >
                ×
              </button>
            </div>
          ))}
          {threads.length === 0 && <div className="threadempty">Nothing here yet</div>}
        </nav>
      </aside>

      <main className="main">
        <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
          {turns.length === 0 && (
            <div className="empty">
              <div className="big">
                Ask your <em>data</em> anything.
              </div>
              <div>Answers arrive as figures, tables, and plain language</div>
            </div>
          )}

          {turns.map((turn) => (
            <div className="turn" key={turn.id}>
              <div className="user-row">
                <div className="user-bubble">{turn.question}</div>
              </div>
              <TurnBody turn={turn} />
            </div>
          ))}
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
              placeholder="Ask about your data…    (Shift+Enter for a new line)"
              disabled={busy}
            />
            {busy ? (
              <Button
                type="button"
                variant="outline"
                className="self-end border-destructive font-mono text-destructive"
                onClick={stop}
              >
                Stop
              </Button>
            ) : (
              <Button type="submit" className="self-end font-mono" disabled={!input.trim()}>
                Ask →
              </Button>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}
