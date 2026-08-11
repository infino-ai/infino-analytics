# @infino-ai/analytics

The facade of the kit: one client object your backend embeds. It gives you
conversational analytics over an Infino database today, and the
visualization/dashboard persistence API next (both surfaces share the same
chart contract, so a chart born in chat can later live on a dashboard).

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
| Anthropic API key | `config.llm.anthropicApiKey`, or `ANTHROPIC_API_KEY`. Needed only for `ask()`; the visualization API never touches an LLM |

## Configuration

```ts
new Analytics(config: AnalyticsConfig)
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `infino.uri` | `string` | required | Database URI: `https://<host>/<database>` |
| `infino.apiKey` | `string?` | `INFINO_API_KEY` | Bearer key for the database |
| `llm.model` | `string?` | `claude-opus-5` | Anthropic model id used by the default harness |
| `llm.anthropicApiKey` | `string?` | `ANTHROPIC_API_KEY` | LLM credential |
| `llm.maxBudgetUsd` | `number?` | `2` | Hard spend ceiling per question; the run stops with an `error` event if it would exceed this |

`llm` as a whole is optional: leave it out entirely if a deployment only uses
the non-conversational surfaces.

## Methods

### `createSession(): string`

Creates a conversation and returns its id. Pass the id to `ask()` so
follow-up questions keep context ("break that down by month" works because
the previous question and its results are remembered).

Sessions are held in memory today: they do not survive a process restart,
and there is no cross-instance sharing. Thread persistence through a
`StorageAdapter` (with a SQLite default) is the next planned change; the
method shape will not change.

### `ask(question, opts?): AsyncGenerator<ChatEvent>`

Runs one question through the agent and yields typed events as work happens.

| Option | Type | Meaning |
|---|---|---|
| `opts.sessionId` | `string?` | Continue the conversation created by `createSession()`. Unknown ids throw. Omit for a one-shot question |
| `opts.signal` | `AbortSignal?` | Cancels the run itself (the model stops, tools stop), not just the event stream. Wire client disconnects to this |

The generator ends after a final `done` event, which always arrives: on
success, on error, and on abort.

```ts
const sessionId = analytics.createSession();
const abort = new AbortController();

for await (const event of analytics.ask("top 10 users by denials", {
  sessionId,
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
| `data` | `columns`, `rows`, `truncated` | A raw result set surfaced without a chart |
| `chart` | `spec`, `result` | A rendered figure: the `VizSpec` plus the executed `ExecuteResult` (full rows ride this event, not the model's context) |
| `summary` | `text` | The final answer, in GitHub-flavored markdown |
| `error` | `message` | Something failed (budget exceeded, engine unreachable). A `done` still follows |
| `done` | `sessionId`, `turns?`, `costUsd?` | Always the last event. `costUsd` is the LLM spend for this question |

A typical successful run looks like:

```
status → progress → step → step_done → … → sql → chart → summary → done
```

## Rendering charts: the binding contract

A `chart` event carries everything a renderer needs:

- `spec` (`VizSpec`): the saved-object shape. `chart.type` is one of
  `bar | line | area | pie | metric | table`; `title`, `source.raw_query`,
  and axis `mapping` describe intent.
- `result` (`ExecuteResult`): `columns`, `rows`, and `metadata` including
  `row_count`, `took_ms`, `warnings`, and `binding`.

The one rule: **read column names only from `result.metadata.binding`**
(`x`, `y[]`, `series`, `value`), never from the spec or by parsing the SQL.
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

## What's next on this facade

`visualizations` and `dashboards` namespaces: persistence (create, get,
list, update, delete) and execution for the same `VizSpec` objects the agent
emits, with dashboard-level filter and time-range injection. Pure data
plane, no LLM in the path. The event and chart contracts above will not
change shape.
