# @infino-ai/analytics

The facade package: the one thing consumers install. `README.md` in this
directory is the full user guide and method reference; this file is the
short map for working on the package itself.

## Surfaces on the `Analytics` class

- `ask(question, {threadId, signal})` yields `ChatEvent`s (the Fino agent);
  with a `threadId` the turn persists through the storage adapter.
- `threads` is the conversation store (CRUD + transcripts), straight from
  the adapter.
- `visualizations` is saved-chart CRUD plus `execute(idOrSpec, {filters,
  timeRange})`, which AND-injects runtime filters into the SQL before
  aggregation (request filters beat saved filters on field collision;
  `timeRange` becomes a between-filter on the spec's `time_column`).
- `dashboards` is dashboard CRUD plus `execute(id)`: a bounded-parallel
  fan-out resolving every panel with per-panel error containment. Dangling
  `viz_id` references are rejected at write time.
- `toEChartsOption(spec, result, theme?)` maps any visualization + its
  executed result to a render plan (`echarts` option, `table`, or
  `metric`). Pure function; also exported from the browser-safe
  `@infino-ai/analytics/echarts` subpath.

## Rules for this package

- The heavy logic does not live here. Schemas, execute, filter injection,
  and storage interfaces belong in `@infino-ai/analytics-core`; the agent
  harness belongs in `@infino-ai/analytics-agent`. This package composes
  them and defines the consumer-facing API shape.
- `src/echarts.ts` must stay browser-safe: no Node built-ins, no imports
  from `src/index.ts` or the agent/storage graph, no `echarts` dependency
  (options are plain JSON).
- `New*` input types are the zod schemas' `z.input` (defaulted fields
  optional); every write path parses before persisting, including after a
  merge patch.
- Documents are updated by full replace through the adapter's `DocStore`;
  RFC 7396 merge-patch semantics (and the protected fields) live in
  `analytics-core`'s `mergePatch`.
- Public API changes must be reflected in `README.md` here; it is the
  customer-facing reference.
