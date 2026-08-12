import type { Binding, ExecuteResult, VizSpec, Warning } from "./spec.js";
import type { InfinoClient } from "./client.js";
import { injectFilters, mergeFilters, timeRangeFilter } from "./filters.js";
import type { Filter, TimeRange } from "./viz.js";

// Cap what execute returns; charts never need more, and the stream carries
// these rows to the client verbatim.
const MAX_ROWS = 5000;
// Above this many distinct x values a categorical chart is unreadable; the
// warning tells the agent to rewrite the SQL with a top-N instead.
const HIGH_CARDINALITY_X = 60;

export interface ExecuteOptions {
  /** Saved filters (from the visualization document). */
  savedFilters?: Filter[];
  /** Runtime filters; win over saved filters on field collision. */
  filters?: Filter[];
  /** Absolute window applied as a synthetic between-filter on the spec's
   * time column (default "@timestamp"). */
  timeRange?: TimeRange;
}

/** Execute a VizSpec: inject runtime filters into its SQL, run it, resolve
 * the axis→column binding against the ACTUAL result columns, and validate
 * the shape. Degrade-never-fail: problems become machine-readable warnings
 * (and skipped filters) and the data still returns, so both renderers and
 * the agent can react. */
export async function execute(
  client: InfinoClient,
  spec: VizSpec,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const started = Date.now();

  const merged = mergeFilters(options.savedFilters ?? [], options.filters ?? []);
  if (options.timeRange) {
    merged.push(timeRangeFilter(options.timeRange, spec.source.time_column));
  }
  const injection = injectFilters(spec.source.raw_query, merged);

  let rows = await client.querySql(injection.sql);

  const warnings: Warning[] = [];
  const truncated = rows.length > MAX_ROWS;
  if (truncated) {
    rows = rows.slice(0, MAX_ROWS);
    warnings.push({
      code: "result_truncated",
      message: `result exceeded ${MAX_ROWS} rows; truncated. Add a LIMIT or aggregate further.`,
    });
  }

  const columns = inferColumns(rows);
  const binding = resolveBinding(spec, columns, rows, warnings);

  return {
    columns,
    rows,
    metadata: {
      source_kind: "sql",
      row_count: rows.length,
      truncated,
      took_ms: Date.now() - started,
      executed_query: injection.sql,
      filters_applied: injection.applied,
      filters_skipped: injection.skipped,
      warnings,
      binding,
    },
  };
}

function inferColumns(rows: Record<string, unknown>[]): { name: string; type: string }[] {
  if (rows.length === 0) return [];
  const sample = rows[0];
  return Object.keys(sample)
    .filter((name) => name !== "_id")
    .map((name) => ({ name, type: valueType(firstNonNull(rows, name)) }));
}

function firstNonNull(rows: Record<string, unknown>[], name: string): unknown {
  for (const row of rows.slice(0, 50)) {
    if (row[name] !== null && row[name] !== undefined) return row[name];
  }
  return null;
}

function valueType(v: unknown): string {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

/** Match a spec-declared column name to an actual result column. Engines
 * rename aliases (case folding is the classic), so fall back to a
 * case-insensitive match before giving up. */
function resolveColumn(
  name: string | undefined,
  columns: { name: string; type: string }[],
): string | null {
  if (!name) return null;
  const exact = columns.find((c) => c.name === name);
  if (exact) return exact.name;
  const ci = columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return ci ? ci.name : null;
}

function resolveBinding(
  spec: VizSpec,
  columns: { name: string; type: string }[],
  rows: Record<string, unknown>[],
  warnings: Warning[],
): Binding {
  const binding: Binding = { x: null, y: [], y2: [], series: null, value: null };
  const chartType = spec.chart.type;

  if (rows.length === 0) {
    warnings.push({ code: "empty_result", message: "query returned no rows" });
    return binding;
  }
  if (chartType === "table") return binding;

  const numericCols = columns.filter((c) => c.type === "number").map((c) => c.name);

  if (chartType === "metric") {
    const declared = resolveColumn(spec.mapping.y[0], columns);
    binding.value = declared ?? (numericCols.length === 1 ? numericCols[0] : null);
    if (!binding.value) {
      warnings.push({
        code: "metric_value_unresolved",
        message: `could not resolve a numeric value column (declared: ${spec.mapping.y[0] ?? "none"}; numeric columns: ${numericCols.join(", ") || "none"})`,
      });
    }
    return binding;
  }

  // bar | horizontalBar | line | area | pie | heatmap | scatter | combo
  binding.x = resolveColumn(spec.mapping.x, columns);
  if (!binding.x) {
    warnings.push({
      code: "x_column_not_found",
      message: `mapping.x ${JSON.stringify(spec.mapping.x ?? null)} not in result columns [${columns.map((c) => c.name).join(", ")}]`,
    });
  }

  for (const y of spec.mapping.y) {
    const resolved = resolveColumn(y, columns);
    if (!resolved) {
      warnings.push({ code: "y_column_not_found", message: `mapping.y column ${JSON.stringify(y)} not in result` });
      continue;
    }
    if (!numericCols.includes(resolved)) {
      warnings.push({ code: "y_column_not_numeric", message: `mapping.y column ${JSON.stringify(resolved)} is not numeric` });
      continue;
    }
    binding.y.push(resolved);
  }
  if (binding.y.length === 0) {
    // Infer: numeric columns that aren't x/series. Warned so the agent can
    // make the mapping explicit next time.
    const inferred = numericCols.filter((c) => c !== binding.x && c !== spec.mapping.series);
    if (inferred.length > 0) {
      binding.y = chartType === "pie" ? [inferred[0]] : inferred;
      warnings.push({
        code: "y_inferred",
        message: `mapping.y unresolved; inferred [${binding.y.join(", ")}] from numeric columns`,
      });
    } else {
      warnings.push({ code: "no_numeric_y", message: "no numeric column available for the y axis" });
    }
  }

  // Secondary axis: resolved like y, but never inferred — a right axis is
  // always an explicit choice.
  for (const y2 of spec.mapping.y2) {
    const resolved = resolveColumn(y2, columns);
    if (!resolved) {
      warnings.push({ code: "y2_column_not_found", message: `mapping.y2 column ${JSON.stringify(y2)} not in result` });
      continue;
    }
    if (!numericCols.includes(resolved)) {
      warnings.push({ code: "y2_column_not_numeric", message: `mapping.y2 column ${JSON.stringify(resolved)} is not numeric` });
      continue;
    }
    binding.y2.push(resolved);
  }

  if (spec.mapping.series && chartType !== "pie") {
    binding.series = resolveColumn(spec.mapping.series, columns);
    if (!binding.series) {
      warnings.push({ code: "series_column_not_found", message: `mapping.series ${JSON.stringify(spec.mapping.series)} not in result` });
    }
  }

  // Per-type shape checks, still degrade-never-fail.
  if (chartType === "heatmap" && !binding.series) {
    warnings.push({
      code: "heatmap_needs_series",
      message: "heatmap needs mapping.series as the row axis (x = columns, y = cell value); rendering falls back to a table without it",
    });
  }
  if (chartType === "scatter" && binding.x && !numericCols.includes(binding.x)) {
    warnings.push({
      code: "scatter_x_not_numeric",
      message: `scatter expects a numeric x; ${JSON.stringify(binding.x)} is not numeric`,
    });
  }
  if (binding.series && binding.y2.length > 0) {
    warnings.push({
      code: "y2_ignored_with_series",
      message: "mapping.series pivots rows into series, so mapping.y2 is ignored; use explicit y/y2 columns instead",
    });
    binding.y2 = [];
  }
  if (chartType === "combo" && binding.y2.length === 0) {
    warnings.push({
      code: "combo_needs_y2",
      message: "combo overlays y2 lines on y bars; without mapping.y2 it renders as plain bars",
    });
  }

  if (
    binding.x &&
    (chartType === "bar" || chartType === "horizontalBar" || chartType === "pie")
  ) {
    const distinct = new Set(rows.map((r) => r[binding.x as string])).size;
    if (distinct > HIGH_CARDINALITY_X) {
      warnings.push({
        code: "high_cardinality_x",
        message: `${distinct} distinct values on x; rewrite the SQL with a top-N (ORDER BY ... LIMIT) for a readable chart`,
      });
    }
  }

  return binding;
}
