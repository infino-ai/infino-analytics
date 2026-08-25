# infino-analytics

A reference kit for building **analytics products** on
[Infino](https://github.com/infino-ai/infino). Two surfaces, usable
together or independently:

- **Visualizations & dashboards** — an API for defining, persisting,
  and executing charts (`VizSpec` in, `{columns, rows, binding}` out)
  that your own frontend renders in your own layout. Pure data plane:
  no LLM anywhere in this path.
- **Fino, the conversational layer** — ask questions in natural
  language; an agent writes the SQL and answers with charts. Fino
  *produces* the same `VizSpec` objects the visualization API persists
  and executes, so a chart born in chat can live on a dashboard —
  but neither surface requires the other.

This is an example application, built to be forked. It shows one way to
assemble the pieces; the seams are designed so you can swap the parts
you already own:

- **LLM seam** — a harness is any generator of `ChatEvent`s. Swap in your
  own model loop; the tools, chart contract, and persistence API do not
  change. `packages/agents/` holds two worked examples (Claude, OpenAI) as
  peers, both held to one conformance suite.
- **Storage seam** — threads, visualizations, and dashboards persist
  through a `StorageAdapter` interface (SQLite by default). Implement it
  over your own database.
- **Engine seam** — data lives in Infino, hosted (Infino Cloud) or
  embedded (local disk / object storage). One connection URI switches
  between them.

## Quickstart

Requires Node 22.18 or newer — the test suite spawns a bare `.ts` child
process and relies on Node's type stripping, which is on by default from
22.18.

```sh
npm install

# 1. Load data (once) — or point at a database you already have
INFINO_API_KEY=... python3 ingestion/bulk_upload.py \
  --database my-demo --table events --file data.ndjson

# 2. Run the chat app
INFINO_URI=https://api.platform.infino.ws/<database> \
INFINO_API_KEY=... ANTHROPIC_API_KEY=... npm run dev
# → http://localhost:8787
# Optional: FINO_SUGGESTIONS="q1|q2|q3" sets the suggested-question chips
# for your dataset; without it, generic suggestions are shown.
# Optional: FINO_HARNESS=openai runs the OpenAI Responses API instead of
# Claude — see the OPENAI_* block in .env.example.
```

Or use the facade directly in your own code:

```ts
import { Analytics } from "@infino-ai/analytics";

const analytics = new Analytics({ infino: { uri, apiKey } });
for await (const event of analytics.ask("which features have the most denials?")) {
  // status | delta | progress | sql | chart (spec + rows + binding) | summary | done
}
```

## Layout

```
ingestion/                example data-loading scripts (run once, before chat)
packages/analytics-core   the contract layer: VizSpec, ChatEvent, StorageAdapter,
                          execute() → { columns, rows, binding, warnings } — no LLM
packages/agents/claude    the default harness (Claude Agent SDK) + tool policy
packages/agents/openai    the OpenAI Responses API over MCP; any compatible
                          deployment (api.openai.com, Azure OpenAI / Foundry)
packages/storage-sqlite   the reference StorageAdapter: app state in one SQLite file
packages/analytics        the facade: new Analytics({...}) — ask() + threads (Fino),
                          visualizations + dashboards (persistence API) on one client
apps/server               the facade over HTTP: POST /api/chat (SSE) + demo UI host
apps/web                  demo chat UI (React + ECharts); <Chart> reads only binding
```

The render contract in one line: the server resolves `metadata.binding`
(axis → actual result column) and the renderer reads only that — your
own frontend does the same against `/api/chat`.

## Forking this kit

The intended path, in the order most forks take it:

1. **Point it at your data.** Copy `.env.example` to `.env`, set
   `INFINO_URI`/`INFINO_API_KEY` to your database, and write your own
   loader (`ingestion/` is an example, not a framework). Set
   `FINO_SUGGESTIONS` to questions that fit your data.
2. **Keep or replace the frontend.** `apps/web` is yours to rebrand, or
   drop it and build against the HTTP surface: `/api/chat` (SSE of
   ChatEvents), `/api/threads`, `/visualizations`, `/dashboards`.
   `toEChartsOption` (from `@infino-ai/analytics`, or the browser-safe
   `@infino-ai/analytics/echarts`) turns any executed visualization into a
   render plan; pass a theme to match your design system.
3. **Swap the storage.** Implement `StorageAdapter` over your database and
   pass it to `new Analytics({storage})`; the bundled SQLite adapter is the
   worked example.
4. **Swap the LLM harness if you need to.** Write an `AgentHarness` — any
   generator of `ChatEvent`s — and pass it as `new Analytics({harness})`.
   The contract layer (`packages/analytics-core`) and everything above it
   stay untouched. `packages/agents/openai` is the worked example; run it
   with `FINO_HARNESS=openai`. A new harness must pass
   `assertHarnessConformance` — the contract's executable spec.
5. **Then delete the harness you did not pick.** A fork answers with one
   LLM, so carrying both means carrying a provider SDK you never call. Set
   `FINO_HARNESS`, then remove the other `packages/agents/*` package, its
   `apps/server` dependency, and its entry in `HARNESSES`. Dropping
   `agents/openai` also drops the `openai` package that sets this repo's
   Node 22.18 floor.
6. **Put your gateway in front.** The reference server ships without
   auth on purpose.

`CLAUDE.md` (root and `packages/analytics/`) orients coding agents working
in a fork — the load-bearing contracts are spelled out there.

## Status

**Working.** Conversational analytics end to end (ask → SQL → chart) with
persistent threads: transcripts survive restarts and a reopened thread resumes
the model's context. The visualization/dashboard persistence API alongside it —
saved charts with runtime filter and time-range injection at execute time,
dashboards referencing them by id, stable REST shapes over HTTP. Two harnesses
(Claude, and the OpenAI Responses API) drive the same UI unchanged, both held
to one conformance suite, all on the same `StorageAdapter`.

**Known limitations.** The OpenAI harness does not compact context or bound
large tool results, so long or data-heavy threads are weaker there than on
Claude; see [Choosing between the bundled two](packages/analytics/README.md#choosing-between-the-bundled-two).
There is no eval set, so answer *quality* across harnesses is unmeasured.
