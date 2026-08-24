# @infino-ai/analytics

The facade of the kit: one client object your backend embeds. It gives you
conversational analytics over an Infino database, and the
visualization/dashboard persistence API. Both surfaces share the same
chart contract, so a chart born in chat can be pinned to a dashboard.

```ts
import { Analytics } from "@infino-ai/analytics";

const analytics = new Analytics({
  infino: { uri: "https://api.platform.infino.ws/<database>", apiKey: "..." },
});

for await (const event of analytics.ask("which features have the most denials?")) {
  if (event.type === "chart") render(event.spec, event.result);
  if (event.type === "summary") console.log(event.text);
}
```

This package is small on purpose. The heavy lifting lives behind two seams:
the agent harness (replaceable, Claude Agent SDK by default) and the contract
layer (`@infino-ai/analytics-core`: `VizSpec`, `ChatEvent`, `execute()`).
Consumers only ever need this package; the types below are re-exported from it.

## Requirements

| What | Where it comes from |
|---|---|
| An Infino database | Infino Cloud (`https://api.platform.infino.ws/<database>`) with your data already ingested (see `ingestion/` at the repo root for example loaders) |
| Infino API key | `config.infino.apiKey`, or the `INFINO_API_KEY` environment variable |
| An LLM credential | `config.llm.apiKey`, or `ANTHROPIC_API_KEY` for the default harness. Needed only for `ask()`; the visualization API never touches an LLM |

## Configuration

```ts
new Analytics(config: AnalyticsConfig)
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `infino.uri` | `string` | required | Database URI: `https://<host>/<database>` |
| `infino.apiKey` | `string?` | `INFINO_API_KEY` | Bearer key for the database |
| `llm.model` | `string?` | `claude-opus-5` | Model id for the built-in harness |
| `llm.apiKey` | `string?` | `ANTHROPIC_API_KEY` | Credential for the built-in harness |
| `llm.maxBudgetUsd` | `number?` | `2` | Hard spend ceiling per question; the run stops with an `error` event if it would exceed this |
| `harness` | `AgentHarness?` | Claude Agent SDK | Replaces the LLM entirely — any generator of `ChatEvent`s. See Swapping the harness below |
| `storage` | `StorageAdapter?` | `InMemoryStorage` | Where threads live. Pass `SqliteStorage` (from `@infino-ai/analytics-storage-sqlite`) or your own adapter; see Threads and persistence below |

`llm` as a whole is optional: leave it out entirely if a deployment only uses
the non-conversational surfaces.

`llm` and `harness` are **mutually exclusive** — `llm` tunes the built-in
harness, `harness` replaces it, so passing both throws at construction rather
than silently ignoring one.

> **Breaking change:** `llm.anthropicApiKey` is now `llm.apiKey`. The facade is
> provider-neutral; the provider is whichever harness you run.

## Swapping the harness

```ts
import { createOpenAIHarness } from "@infino-ai/analytics-agent-openai";

const analytics = new Analytics({
  infino: { uri },
  harness: createOpenAIHarness({ infino: { uri } }),
});
```

An `AgentHarness` is `(params) => AsyncGenerator<ChatEvent, {sessionId?}>` and
nothing more. Writing your own: implement that, reuse `buildSystemPrompt`,
`runCreateChart`, `stepDetail`, and `drain` from `@infino-ai/analytics-core`,
and assert it with `assertHarnessConformance` from
`@infino-ai/analytics-core/conformance`.

### Choosing between the bundled two

Both satisfy the same contract, so the UI and the persistence API cannot tell
them apart. They are not equivalent in what they give you.

| | `claude` (default) | `openai` |
|---|---|---|
| Provider | Anthropic, via the Claude Agent SDK | Any OpenAI Responses endpoint — `api.openai.com`, Azure OpenAI / AI Foundry |
| Spend ceiling | `maxBudgetUsd`, enforced in real dollars | `maxTotalTokens`, a proxy checked **between turns** — a single runaway turn is unbounded |
| `done.costUsd` | reported | omitted; the API bills tokens, not dollars |
| `summary` event | emitted | never — the Responses API has no second copy of the final text |
| Web search | yes (`WebSearch`/`WebFetch`) | no; the system prompt drops that promise |
| Long threads | SDK compacts context automatically | **no compaction** — server-side history grows until the model's limit, then the turn fails |
| Large tool results | SDK truncates before they reach the model | **unbounded** — a wide `infino_sql` can exhaust context (`create_chart` is safe: the model gets a 5-row receipt) |
| Built-in tools | ships Bash/file I/O, so a deny list is mandatory | none; the model sees exactly the tools you pass |

Read the last three rows together. The Claude harness is more robust on long
or data-heavy conversations because the SDK is doing work we have not
reimplemented. The OpenAI harness is safer by construction, because there is
no ambient tool surface to lock down. Pick accordingly, and treat the two
"unbounded" rows as known limitations rather than settled design.

## Methods

### `threads` (property): the conversation store

Thread CRUD and transcripts, backed by whatever `storage` you configured:

| Method | Meaning |
|---|---|
| `threads.create({id?, title?})` | New thread. The title auto-sets from the first question if left empty |
| `threads.get(id)` | The thread, or `null` |
| `threads.list({limit?, before?})` | Newest activity first; `before` pages by `updatedAt` |
| `threads.rename(id, title)` | Set the title |
| `threads.delete(id)` | Remove the thread and its messages |
| `threads.appendMessage(threadId, msg)` | Append a turn; message ids may be client-supplied (duplicate ids are rejected, making retries idempotent) |
| `threads.listMessages(threadId, {limit?, before?})` | The transcript, oldest first; `before` pages backwards from a message id |

### `createSession(): Promise<string>`

Sugar over `threads.create()`: creates a thread and returns its id.

### `ask(question, opts?): AsyncGenerator<ChatEvent>`

Runs one question through the agent and yields typed events as work happens.

| Option | Type | Meaning |
|---|---|---|
| `opts.threadId` | `string?` | Persist this turn to the thread and continue its conversation ("break that down by month" works because the previous question and results are remembered). Unknown ids throw. Omit for a one-shot question that leaves no trace |
| `opts.signal` | `AbortSignal?` | Cancels the run itself (the model stops, tools stop), not just the event stream. Wire client disconnects to this |

The generator ends after a final `done` event, which always arrives: on
success, on error, and on abort.

```ts
const threadId = await analytics.createSession();
const abort = new AbortController();

for await (const event of analytics.ask("top 10 users by denials", {
  threadId,
  signal: abort.signal,
})) {
  switch (event.type) {
    case "chart":   render(event.spec, event.result); break;
    case "sql":     showQuery(event.query); break;
    case "summary": showAnswer(event.text); break;
    case "error":   showError(event.message); break;
  }
}
```

## Threads and persistence

With a `threadId`, `ask()` persists the turn through the storage adapter:
the user's question, then one assistant message holding the full event list
that was shown (charts included, with their result rows). History re-renders
from the transcript without re-querying, so numbers don't drift and old
threads outlive schema changes. Transient events (`status`, `delta`) are
never persisted; a turn ended early by abort or error persists whatever had
arrived, which is exactly what the user saw.

The adapter also keeps the agent harness's session pointer per thread, so a
reopened thread resumes with the model's conversational context. That
context lives with the harness on the server host, not in the adapter: if
it's gone (new machine), the thread still renders fully from the transcript
and the conversation simply continues with fresh context.

Storage is a seam: consumers type against the `StorageAdapter` interface
only, so swapping databases is constructing a different adapter.

```ts
import { SqliteStorage } from "@infino-ai/analytics-storage-sqlite";

const analytics = new Analytics({
  infino: { uri, apiKey },
  storage: new SqliteStorage({ path: "./data/analytics.db" }),
});
```

Bundled adapters:

- `InMemoryStorage` (the default): zero setup, nothing survives a restart.
- `SqliteStorage` (`@infino-ai/analytics-storage-sqlite`): one file, WAL
  mode, no infrastructure; right for development and single-node production.

Application state is yours to own. For your database, implement the
`ThreadStore` methods above over it; the interface is async throughout, so
network-backed stores fit naturally, and the two bundled adapters are the
worked examples.

## Event reference

`ask()` yields `ChatEvent` values. Consumers should switch on `type` and
ignore types they don't handle; new event types may be added over time.

| Event | Payload | When |
|---|---|---|
| `status` | `text` | Transient activity label ("thinking"). Replaces the previous status; display only the latest |
| `step` | `id`, `tool`, `detail?` | A tool call started. `tool` is the bare tool name, `detail` is a one-line input summary (the SQL text, the table name) |
| `step_done` | `id`, `ok` | The step with that `id` finished; `ok: false` means the tool errored (the agent usually self-corrects and continues) |
| `delta` | `text` | A streamed text chunk of the message being written. Superseded by the next `progress`/`summary`, which carries the complete text |
| `progress` | `text` | A complete intermediate text block (the agent narrating its work) |
| `sql` | `query` | The exact SQL behind the chart that follows. Show it for transparency/copy |
| `chart` | `spec`, `result` | A rendered figure: the `VizSpec` plus the executed `ExecuteResult` (full rows ride this event, not the model's context) |
| `summary` | `text` | The final answer, in GitHub-flavored markdown. Not every harness emits it — treat it as a `progress` that happens to be last |
| `error` | `message` | Something failed (budget exceeded, engine unreachable). A `done` still follows |
| `done` | `sessionId`, `turns?`, `costUsd?` | Always the last event. `costUsd` is the LLM spend for this question, when the provider reports cost at all |

A typical successful run looks like:

```
status → progress → step → step_done → … → sql → chart → summary → done
```

Only `done` is guaranteed, and only as the last event. Switch on `type` and
ignore the rest; that is what keeps a UI working across harnesses.

## Rendering charts: the binding contract

A `chart` event carries everything a renderer needs:

- `spec` (`VizSpec`): the saved-object shape. `chart.type` is one of
  `bar | horizontalBar | line | area | pie | metric | table | heatmap |
  scatter | combo`;
  `title`, `source.raw_query`, and axis `mapping` describe intent
  (`mapping.y2` puts columns on a secondary right axis; for heatmap, `x` is
  the column axis, `series` the row axis, `y[0]` the cell value).
- `result` (`ExecuteResult`): `columns`, `rows`, and `metadata` including
  `row_count`, `took_ms`, `warnings`, and `binding`.

The one rule: **read column names only from `result.metadata.binding`**
(`x`, `y[]`, `y2[]`, `series`, `value`), never from the spec or by parsing
the SQL.
The binding is resolved server-side against the actual result columns, which
matters because engines rename aliases. `metadata.warnings` lists anything
the executor degraded rather than failed on (e.g. a high-cardinality x axis);
surface them subtly.

The demo UI's `<ChartCard>` (`apps/web/src/Chart.tsx`) is the worked example
of a conforming ECharts renderer.

## Errors and cancellation

- Configuration mistakes (unknown `sessionId`) throw synchronously.
- Runtime failures inside a run (engine errors, LLM errors, budget ceiling)
  arrive as an `error` event followed by `done`; the generator completes
  normally rather than throwing, so a UI can render the failure in place.
- Aborting via `opts.signal` ends the run with a `done` event and no error:
  cancellation is a normal outcome.

## Visualizations and dashboards

The persistence + execution surface for saved charts: pure data plane, no
LLM anywhere in this path. Both namespaces live on the same
`StorageAdapter` object threads use.

### `visualizations`

| Method | Meaning |
|---|---|
| `create(input)` | Lenient create: identity and defaults filled in. The input is a `VizSpec` plus optional `filters`/`time_range`/`tags`, exactly what a `chart` event carries, so pinning from chat is `create({ ...event.spec })` |
| `get(id)` / `list({ids?, limit?, offset?})` | Fetch; `list` returns newest-updated first |
| `put(id, input)` | Strict full-document replace |
| `update(id, patch)` | RFC 7396 merge patch (`null` removes a key; `id`, `schema_version`, `created_at`, `created_by` are protected) |
| `delete(id)` | Remove |
| `execute(idOrSpec, {filters?, timeRange?})` | Run it: runtime filters are AND-injected into the SQL (they win over saved filters on field collision), `timeRange` becomes a between-filter on the spec's `time_column`. Passing an inline spec instead of an id executes without persisting |

Filter operators: `is`, `is_not`, `is_one_of`, `is_not_one_of`,
`is_between`, `is_not_between`, `exists`, `does_not_exist`, `contains`.
Injection is AST-level (parse, AND into `WHERE`, re-serialize), so filters
apply before aggregation. Degrade-never-fail: a filter that can't be
injected safely lands in `metadata.filters_skipped` with a reason and the
query still runs; `metadata.filters_applied` lists what made it in.

### `dashboards`

Same CRUD shape (`create/get/list/put/update/delete`). A dashboard is
layout + references: panels point at visualizations **by id** (dangling
references are rejected at write time), plus `markdown` and `divider`
panels, dashboard-level `filters`/`time_range`, and a 48-column grid
`layout` per panel that round-trips untouched.

`dashboards.execute(id, {filters?, timeRange?, concurrency?})` resolves
every panel in one call: each visualization panel executes in parallel
with the dashboard's filters and time range (overridable), and returns
`{kind, layout, title_override, viz, data, error}` per panel in dashboard
order. A failing panel lands in its own `error`; the dashboard still
renders. Over HTTP there is deliberately no dashboard-execute route — the
reference web app fans out per panel the same way this method does.

### Rendering: `toEChartsOption(spec, result, theme?)`

The step after execute. A pure function mapping any visualization (or
VizSpec) plus its `ExecuteResult` into a render plan:

```ts
const plan = toEChartsOption(viz, data);
// { kind: "echarts", option }  → echarts.setOption(plan.option)
// { kind: "table", columns, rows }   → your table component
// { kind: "metric", value, label, text } → your big-number component
```

It reads only `metadata.binding`, covers every chart type in the enum,
and degrades unresolvable grids/scatters to a table. The optional `theme`
overrides colors and fonts to match your design system. Call it wherever
suits your architecture: in your backend (ship `plan.option` to your
frontend as JSON) via this package's main entry, or in the browser via
`@infino-ai/analytics/echarts` — the same function from an entry that
carries none of the server-side code. The demo app's chart component is
its worked example.

### Over HTTP

The reference server exposes both namespaces over REST (`GET/POST
/visualizations`, `PUT/PATCH/GET/DELETE /visualizations/:id`, `POST /visualizations/:id/data` with the reserved id
`_execute` for inline specs; same pattern under `/dashboards`), returning
`{ id, kind, created_at, updated_at, attributes }` envelopes. No auth on
purpose; put your gateway in front.
