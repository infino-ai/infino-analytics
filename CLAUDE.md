# infino-analytics

A reference kit for building analytics products on [Infino](https://github.com/infino-ai/infino):
Fino, a conversational analytics agent, plus a visualization/dashboard
persistence API. It is built to be forked; the seams below mark what a fork
swaps and what it must preserve.

## Commands

```sh
npm install              # Node 22+
npm run typecheck        # tsc across all packages, tests, and the web app
npm test                 # node:test over the pure logic; no network
npm run build            # bundles the web app (Vite)
npm run dev              # builds web, starts the reference server on :8787
```

The server needs `INFINO_URI` (https://<host>/<database>), `INFINO_API_KEY`,
and `ANTHROPIC_API_KEY`. Optional: `FINO_MODEL`, `FINO_DB` (SQLite path),
`FINO_SUGGESTIONS` (pipe-separated question chips), `PORT`.
`FINO_HARNESS=foundry` swaps in the Azure harness, which needs
`FOUNDRY_OPENAI_ENDPOINT`, `FOUNDRY_API_KEY`, and `FOUNDRY_OPENAI_MODEL`
(a deployment name) instead of `ANTHROPIC_API_KEY`.

`npm test` covers the pure logic (filters, execute/binding, mergePatch,
toEChartsOption, the ask() seam, the Foundry stream mapper and turn loop) —
no network, no credentials. Anything touching a provider is verified by
`npm run smoke -w @infino-ai/analytics-agent-foundry` and by exercising the
running server.

## Layout

```
packages/analytics-core     contract layer: VizSpec, ChatEvent, execute(),
                            filter injection, StorageAdapter, AgentHarness,
                            the create_chart tool contract. No LLM SDK.
packages/agent              the LLM harness (Claude Agent SDK): event loop,
                            tool policy, system prompt. Replaceable.
packages/agent-foundry      second harness: GPT-5 on Azure AI Foundry, MCP
                            client for the data tools. Selected by FINO_HARNESS.
packages/storage-sqlite     reference StorageAdapter (one SQLite file)
packages/analytics          the facade consumers install: Analytics class,
                            toEChartsOption. Depends on all of the above.
apps/server                 the facade over HTTP (Hono): /api/chat SSE,
                            /api/threads, /visualizations, /dashboards
apps/web                    demo UI (React + Vite + Tailwind + ECharts)
ingestion/                  example bulk loader (REST, run once)
```

Dependency direction: `analytics -> agent -> analytics-core`, and the
storage and alternative-harness packages depend only on `analytics-core`.
Never invert these. `analytics` defaults to the Claude harness, so only the
app picks a different one — that is what keeps a second provider's SDK out
of the facade's dependency graph.

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
- **Degrade, never fail.** Execute problems become machine-readable
  `warnings` and `filters_skipped` entries while the data still returns;
  renderers fall back to a table when a binding cannot resolve. Do not turn
  these paths into thrown errors.
- **`ChatEvent` is the harness contract** (`analytics-core/src/events.ts`).
  A replacement LLM harness is any generator yielding these events; the
  facade, server, and UI must keep working with nothing but the events.
  The type is `AgentHarness` (`analytics-core/src/harness.ts`); pass one as
  `new Analytics({harness})`. The chart tool is shared by every harness
  (`analytics-core/src/chart-tool.ts`) so its contract cannot drift.
- **Storage is a seam.** Consumers type against `StorageAdapter` only; a
  new database is a new adapter package, not edits to consumers.
- **The Foundry harness diverges deliberately** (`agent-foundry/src/index.ts`):
  no `done.costUsd` (Azure bills tokens, not dollars — the ceiling is
  `maxTotalTokens`), no `summary` event (the Responses API has no second copy
  of the final text), and no web search. It also owns the MCP child process
  the Claude SDK used to own, so every exit path must close it.
- **Tool policy** (`agent/src/index.ts`): under `dontAsk`, `allowedTools`
  only auto-approves; `disallowedTools` is what actually blocks. Host-
  reaching tools (Bash, file I/O) stay denied because the server process
  holds API keys.
- The `@infino-ai/analytics` package has two entries: the main entry is
  Node-only (it pulls in the agent harness); browser bundles import
  `@infino-ai/analytics/echarts`. Keep `echarts.ts` free of Node built-ins
  and server imports.

## Conventions

- Packages export TypeScript source directly (`exports` maps to `src/`);
  the only build step is the web bundle.
- The web app's UI primitives are vendored shadcn-style components under
  `apps/web/src/components/ui` on Tailwind v4; the design tokens live in
  `apps/web/src/styles.css` (`@theme inline` maps them to the palette).
- User-facing labels use sentence case.
- API keys never appear in code or committed files; they arrive via
  environment variables.
