import { z } from "zod";

// The saved-object shape a chart lives as. The agent emits these; later,
// "pin to dashboard" persists exactly this object, and the dashboard API
// re-executes it with filters/time-range injected. Never store a rendered
// chart — store the spec that can reproduce it.

export const CHART_TYPES = ["bar", "line", "area", "pie", "metric", "table"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const SqlSourceSchema = z.object({
  kind: z.literal("sql"),
  table: z.string().min(1),
  raw_query: z.string().min(1),
  // Column used when a dashboard time-range is injected (P2). Stored now so
  // specs created in chat are dashboard-ready later.
  time_column: z.string().optional(),
});

export const MappingSchema = z.object({
  // Column names from the query result. Pure axis binding — nothing else.
  x: z.string().optional(),
  y: z.array(z.string()).default([]),
  series: z.string().optional(),
});

export const VizSpecSchema = z.object({
  schema_version: z.literal(1).default(1),
  title: z.string().min(1),
  source: SqlSourceSchema,
  chart: z.object({ type: z.enum(CHART_TYPES) }),
  mapping: MappingSchema.default({ y: [] }),
  options: z
    .object({
      legend: z.boolean().optional(),
      metric_format: z
        .object({
          prefix: z.string().optional(),
          suffix: z.string().optional(),
          decimals: z.number().int().min(0).max(6).optional(),
        })
        .optional(),
    })
    .default({}),
});

export type VizSpec = z.infer<typeof VizSpecSchema>;
export type SqlSource = z.infer<typeof SqlSourceSchema>;
export type Mapping = z.infer<typeof MappingSchema>;

/** Axis → result-column map, resolved server-side against the ACTUAL result
 * columns. Renderers read only this — never derive column names from the
 * spec, because engines rename aliases. */
export interface Binding {
  x: string | null;
  y: string[];
  series: string | null;
  /** metric charts: the single value column */
  value: string | null;
}

export interface Warning {
  code: string;
  message: string;
}

export interface ExecuteResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  metadata: {
    source_kind: "sql";
    row_count: number;
    truncated: boolean;
    took_ms: number;
    executed_query: string;
    warnings: Warning[];
    binding: Binding;
  };
}
