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

- **LLM seam** — the agent harness is a thin layer (Claude Agent SDK by
  default). Replace it with your own model loop; the tools, chart
  contract, and persistence API don't change.
- **Storage seam** — threads, visualizations, and dashboards persist
  through a `StorageAdapter` interface (SQLite by default). Implement it
  over your own database.
- **Engine seam** — data lives in Infino, hosted (Infino Cloud) or
  embedded (local disk / object storage). One connection URI switches
  between them.

## Quickstart

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
packages/agent            the LLM harness (Claude Agent SDK) + tools + prompts;
                          replaceable: anything yielding ChatEvents fits the seam
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
   pass it to `new Analytics({storage})`; the bundled SQLite and Infino
   adapters are the worked examples.
4. **Swap the LLM harness if you need to.** `packages/agent` is the seam:
   anything that yields `ChatEvent`s fits. The contract layer
   (`packages/analytics-core`) and everything above it stay untouched.
5. **Put your gateway in front.** The reference server ships without
   auth on purpose.

`CLAUDE.md` (root and `packages/analytics/`) orients coding agents working
in a fork — the load-bearing contracts are spelled out there.

## Status

Working: conversational analytics end to end (ask -> SQL -> chart) with
persistent threads (transcripts survive restarts, reopened threads resume
the model's context), and the visualization/dashboard persistence API:
saved charts with runtime filter/time-range injection at execute,
dashboards referencing them by id, stable REST shapes over HTTP.
All of it on the same StorageAdapter.
