# infino-analytics

A reference kit for building analytics products on [Infino](https://github.com/infino-ai/infino):
Fino, a conversational analytics agent, plus a visualization/dashboard
persistence API. It is built to be forked; the seams below mark what a fork
swaps and what it must preserve.

## Commands

```sh
npm install
npm run typecheck        # tsc across all packages + the web app
npm run build            # bundles the web app (Vite)
npm run dev              # builds web, starts the reference server on :8787
```

The server needs `INFINO_URI` (https://<host>/<database>), `INFINO_API_KEY`,
and `ANTHROPIC_API_KEY`. Optional: `FINO_MODEL`, `FINO_DB` (SQLite path),
`FINO_STORAGE=infino` (threads in the Infino database instead of SQLite),
`FINO_SUGGESTIONS` (pipe-separated question chips), `PORT`.

There is no test suite; verification is `npm run typecheck`, a web build,
and exercising the running server.

## Layout

```
packages/analytics-core     contract layer: VizSpec, ChatEvent, execute(),
                            filter injection, StorageAdapter. No LLM code.
packages/agent              the LLM harness (Claude Agent SDK) + the
                            create_chart tool + system prompt. Replaceable.
packages/storage-sqlite     default StorageAdapter (one SQLite file)
packages/storage-infino     StorageAdapter over Infino engine tables
packages/analytics          the facade consumers install: Analytics class,
                            toEChartsOption. Depends on all of the above.
apps/server                 the facade over HTTP (Hono): /api/chat SSE,
                            /api/threads, /visualizations, /dashboards
apps/web                    demo UI (React + Vite + Tailwind + ECharts)
ingestion/                  standalone demo-data loader (REST, run once)
```

Dependency direction: `analytics -> agent -> analytics-core`, and the
storage packages depend only on `analytics-core`. Never invert these.

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
  (`agent/src/tools.ts`), and the option builder
  (`analytics/src/echarts.ts`).
- **Degrade, never fail.** Execute problems become machine-readable
  `warnings` and `filters_skipped` entries while the data still returns;
  renderers fall back to a table when a binding cannot resolve. Do not turn
  these paths into thrown errors.
- **`ChatEvent` is the harness contract** (`analytics-core/src/events.ts`).
  A replacement LLM harness is any generator yielding these events; the
  facade, server, and UI must keep working with nothing but the events.
- **Storage is a seam.** Consumers type against `StorageAdapter` only; a
  new database is a new adapter package, not edits to consumers.
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
