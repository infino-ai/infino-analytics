# infino-analytics

A reference kit for building analytics products on [Infino](https://github.com/infino-ai/infino):
Fino, a conversational analytics agent, plus a visualization/dashboard
persistence API. It is built to be forked; the seams below mark what a fork
swaps and what it must preserve.

## Commands

```sh
npm install              # Node 22.18+ (tests spawn a bare .ts child)
npm run typecheck        # tsc across all packages, tests, and the web app
npm test                 # node:test over the pure logic; no network
npm run build            # bundles the web app (Vite)
npm run dev              # builds web, starts the reference server on :8787
```

The server needs `INFINO_URI` (https://<host>/<database>), `INFINO_API_KEY`,
and `ANTHROPIC_API_KEY`. Optional: `FINO_MODEL`, `FINO_DB` (SQLite path),
`FINO_SUGGESTIONS` (pipe-separated question chips), `FINO_DOMAIN_CONTEXT`
(operator notes about the dataset, appended to the agent's system prompt),
`FINO_MAX_TURNS` (per-question turn ceiling), `PORT`. `FINO_HARNESS` picks the
harness and is required — `claude`, `openai` or `opencode`, no default. `openai` needs `OPENAI_BASE_URL`,
`OPENAI_API_KEY`, and `OPENAI_MODEL` instead of `ANTHROPIC_API_KEY`, and takes
an optional `OPENAI_REASONING_EFFORT` (none/low/medium/high). `opencode` needs
`OPENCODE_MODEL` (`<provider>/<model>`) plus whatever credentials that
provider reads from the environment, and takes optional `OPENCODE_DATA_DIR`
and `OPENCODE_MCP_TIMEOUT_MS` (per tool call, default 120 s).
`FINO_DOMAIN_CONTEXT` and `FINO_MAX_TURNS` reach every harness. The cost
ceiling does not: `FINO_MAX_BUDGET_USD` is Claude's and opencode's (they
report dollars) and `FINO_MAX_TOTAL_TOKENS` is OpenAI's (it bills tokens).

`npm test` covers the pure logic (filters, execute/binding, mergePatch,
toEChartsOption, the ask() seam, the OpenAI stream mapper and turn loop, the
opencode event mapper and chart server) plus
a conformance suite every harness must pass — no network, no credentials.
Anything touching a live provider is verified by
`npm run smoke -w @infino-ai/analytics-agent-openai` (or `-opencode`) and by
exercising the running server.

## Layout

```
packages/analytics-core     contract layer: VizSpec, ChatEvent, execute(),
                            filter injection, StorageAdapter, AgentHarness,
                            the create_chart tool contract. No LLM SDK.
packages/agents/claude      Claude Agent SDK event loop + the tool policy.
                            A peer, not a default.
packages/agents/openai      OpenAI Responses API harness + its MCP client. Any
                            compatible deployment; selected by FINO_HARNESS.
packages/agents/opencode    opencode server harness: spawns the pinned binary,
                            serves create_chart to it as a local HTTP MCP.
packages/storage-sqlite     reference StorageAdapter (one SQLite file)
packages/analytics          the facade consumers install: Analytics class,
                            toEChartsOption. Depends on all of the above.
apps/server                 the facade over HTTP (Hono): /api/chat SSE,
                            /api/threads, /visualizations, /dashboards
apps/web                    demo UI (React + Vite + Tailwind + ECharts)
ingestion/                  example bulk loader (REST, run once)
```

Dependency direction: `analytics -> analytics-core`, and the storage and
harness packages depend only on `analytics-core`. Never invert these.
`analytics` depends on NO harness package and has no default: `apps/server`
is the only place a provider is named, behind a dynamic import per entry in
`HARNESSES`. That is what lets a deployment carry one provider instead of
all of them — an OpenAI-only fork deletes the other `packages/agents/*`, their
`apps/server` dependencies, and their `HARNESSES` entries, and nothing else
changes.

## Load-bearing contracts

Break any of these and consumers break with you.

- **Renderers read only `result.metadata.binding`** to find columns; never
  derive column names from the SQL, the spec, or by guessing aliases. The
  server resolves the binding against the actual result columns.
- **VizSpec is a persisted, re-executable object.** The model (and any
  code) must never emit finished chart-library JSON as the artifact; store
  the spec, rebuild the option at render time via `toEChartsOption`.
- **Chart types are an enumerated contract.** Adding one touches four
  places: the `CHART_TYPES` enum + semantics comment
  (`analytics-core/src/spec.ts`), binding/shape checks
  (`analytics-core/src/execute.ts`), the tool description intuition
  (`analytics-core/src/chart-tool.ts`), and the option builder
  (`analytics/src/echarts.ts`).
- **Degrade, never fail — at execute time.** Problems found while running a
  query become machine-readable `warnings` and `filters_skipped` entries
  while the data still returns; renderers fall back to a table when a
  binding cannot resolve. Do not turn these paths into thrown errors.
  Malformed *arguments* are the other half and behave the opposite way: a
  filter whose operator is not in `FilterSchema` is rejected where it enters
  (the facade parses request filters; saved ones were parsed on write), so
  the caller gets the vocabulary back — a 400 over HTTP. Degrading there
  would mean silently ignoring what the caller asked for, and the receipt
  would blame the query for a bad argument.
- **`ChatEvent` is the harness contract** (`analytics-core/src/events.ts`).
  A replacement LLM harness is any generator yielding these events; the
  facade, server, and UI must keep working with nothing but the events.
  The type is `AgentHarness` (`analytics-core/src/harness.ts`); pass one as
  `new Analytics({harness})`. The chart tool is shared by every harness
  (`analytics-core/src/chart-tool.ts`) so its contract cannot drift.
- **Storage is a seam.** Consumers type against `StorageAdapter` only; a
  new database is a new adapter package, not edits to consumers.
- **Harnesses are peers under `packages/agents/`**, mirroring `storage-*`:
  `<seam>-<implementation>`. None is privileged and none is a default —
  `apps/server` requires `FINO_HARNESS` to name one from `HARNESSES`, and
  booting without it is an error, because a fallback would quietly make one
  provider the answer. Each entry owns its own env block, so a knob only
  reaches the harness that understands it.
- **A package names its own provider and nothing else.** Peers never name each
  other; `analytics-core`, `analytics`, `storage-*` and `apps/web` name none.
  Comments count — prose drifts before code does. The `seam boundaries` suite
  in `analytics-core/test` enforces both that and the rule that `analytics`
  declares no harness dependency, which is what lets a fork ship one provider.
- **The OpenAI harness diverges deliberately** (`agents/openai/src/index.ts`):
  no `done.costUsd` (the API bills tokens, not dollars — the ceiling is
  `maxTotalTokens`), no `summary` event (the Responses API has no second copy
  of the final text), and no web search. It also owns the MCP child process
  the Claude SDK used to own, so every exit path must close it.
- **The opencode harness diverges too** (`agents/opencode/src/index.ts`): no
  `summary` event and no web search, and `FINO_MAX_TURNS` does not end the run
  with an error: at the ceiling opencode switches the tools off and the model
  writes a final answer from what it has. opencode runs tools in its own process,
  so `create_chart` cannot push into the run's queue: `agents/opencode/src/charts.ts`
  serves it as a remote MCP on a secret localhost path, parks the UI events in a
  ledger keyed by the receipt, and the run claims them when opencode hands that
  receipt back as the tool output. No opaque id goes in the receipt: opencode
  drops MCP `_meta`, and a model echoes ids it sees into its answer. Every
  opencode built-in tool is disabled, and boot fails if opencode reports one
  the list does not know, so an upgrade cannot hand the agent a new host tool.
  Permissions are all `deny`, `doom_loop` included: nobody is there to answer a
  prompt, so opencode refuses the call and the model reads the refusal. A run
  that still asks is aborted. A run silent past the tool timeout plus three
  minutes is aborted as stuck, and one whose consumer walks away is aborted so
  it stops spending. opencode's HTTP API can read its config (which holds the
  Infino key) and open a shell, so it takes a random password per boot; the
  host's `OPENCODE_*` variables never reach it, and the Infino MCP child gets
  only `PATH`, `HOME`, temp dirs and `INFINO_*` (`src/mcp-launcher.mjs`). A run
  sends its question under an id it generates and counts only replies to that
  question, so a previous run on the thread cannot end it. Chart receipts stay
  under opencode's 51,200-byte output cut, or the chart could not be matched.
  The binary and SDK are pinned to the same exact version; bump them together.
- **Tool policy** (`agents/claude/src/index.ts`): under `dontAsk`, `allowedTools`
  only auto-approves; `disallowedTools` is what actually blocks. Host-
  reaching tools (Bash, file I/O) stay denied because the server process
  holds API keys.
- The `@infino-ai/analytics` package has two entries: the main entry is
  Node-only (it pulls in the agent harness); browser bundles import
  `@infino-ai/analytics/echarts`. Keep `echarts.ts` free of Node built-ins
  and server imports.

## Known limitations

Real, not theoretical. Do not paper over them with a comment; fix or flag.

- **The OpenAI harness does not manage context.** `previous_response_id` grows
  the server-side conversation monotonically and `agents/openai/src/loop.ts`
  has no compaction. A long thread eventually fails the turn instead of
  degrading. The Claude SDK and opencode handle this for their harnesses.
- **Tool output is unbounded into model context** on the OpenAI path.
  `mcp.call()` returns whatever the server sends. `create_chart` is safe (the
  model gets a 5-row receipt; full rows ride the side channel), but a wide
  `infino_sql` is not. Any fix belongs in `agents/openai/src/tools.ts`, and
  the truncation must be visible to the model, not silent.
- **`maxTotalTokens` is checked between turns only**, so it bounds a runaway
  loop but not a single runaway turn. It is a cost proxy, not `maxBudgetUsd`.
  The opencode budget has the same shape: it is checked as each model call
  reports its cost.
- **opencode sessions live in `OPENCODE_DATA_DIR`.** A thread resumes only
  while that directory survives; in a container it needs a volume. A lost
  session restarts the conversation rather than failing.
- **No eval set.** The conformance suite proves a harness honours the
  contract; nothing measures whether it answers *well*. Prompt or model
  changes are currently unfalsifiable — say so rather than claiming parity.

## Adding a harness

Additive by construction: a new package plus one line of wiring. Nothing in
`analytics-core`, `analytics`, `apps/web`, or the other harnesses changes.

1. `packages/agents/<name>`, depending only on `@infino-ai/analytics-core`
   (plus the provider SDK). Name it `@infino-ai/analytics-agent-<name>`.
2. Export `create<Name>Harness(config): AgentHarness`. Map the provider's
   stream to `ChatEvent`s; keep that mapping a pure function so it is testable
   without a network.
3. Reuse, do not re-derive: `buildSystemPrompt` (capability flags, not a second
   copy), `runCreateChart`, `stepDetail`, `drain`.
4. Honour the terminal semantics — abort yields `done` and never `error`; a
   failure yields `error` then `done`.
5. **Add `assertHarnessConformance("<name>", …)`** from
   `@infino-ai/analytics-core/conformance`. Non-negotiable: it is the contract's
   only executable definition. Give the provider boundary an injectable seam so
   the suite can drive the real harness offline.
6. One entry in `HARNESSES` in `apps/server/src/index.ts`, plus `.env.example`.

Deliberately NOT abstracted, so nobody "fixes" it: the MCP client and the turn
loop live in `agents/openai` alone. The Claude SDK and opencode own their own
loops and spawn MCP from config, so each is single-copy — extracting a one-consumer
abstraction would be the smell, not the cure.

## Conventions

- Packages export TypeScript source directly (`exports` maps to `src/`);
  the only build step is the web bundle.
- The web app's UI primitives are vendored shadcn-style components under
  `apps/web/src/components/ui` on Tailwind v4; the design tokens live in
  `apps/web/src/styles.css` (`@theme inline` maps them to the palette).
- User-facing labels use sentence case.
- API keys never appear in code or committed files; they arrive via
  environment variables.
