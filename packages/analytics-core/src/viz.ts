import { randomUUID } from "node:crypto";
import { z } from "zod";
import { VizSpecSchema } from "./spec.js";

// The persistence documents for the visualization/dashboard API
// (schema_version: 1). A Visualization is a VizSpec — the exact object the
// conversational agent emits — plus identity, saved filters, and audit
// fields; a Dashboard references visualizations by id (never embeds them)
// and lays them out on the 48-column grid convention. Layout numbers
// round-trip untouched: rendering is the consumer's job.

// ── filters ────────────────────────────────────────────────────────────────

export const FILTER_OPERATORS = [
  "is",
  "is_not",
  "is_one_of",
  "is_not_one_of",
  "is_between",
  "is_not_between",
  "exists",
  "does_not_exist",
  "contains",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const FilterSchema = z.object({
  /** Any unique string; generated when omitted. */
  id: z.string().optional(),
  /** Raw column identifier — never pre-quoted. */
  field: z.string().min(1),
  operator: z.enum(FILTER_OPERATORS),
  /** Scalar for is/is_not/contains; array for *_one_of; [lo, hi] or
   * {from, to} for *_between; ignored for exists/does_not_exist. */
  value: z.unknown().optional(),
  enabled: z.boolean().default(true),
  is_time_filter: z.boolean().default(false),
});
export type Filter = z.infer<typeof FilterSchema>;

/** Absolute time window; ISO-8601 strings or epoch-ms numbers, UTC. */
export const TimeRangeSchema = z.object({
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]),
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

// ── documents ──────────────────────────────────────────────────────────────

export const VisualizationSchema = VizSpecSchema.extend({
  id: z.string().min(1),
  description: z.string().optional(),
  /** Saved filters, merged with request filters at execute time (request
   * wins on field collision). */
  filters: z.array(FilterSchema).default([]),
  time_range: TimeRangeSchema.optional(),
  tags: z.array(z.string()).default([]),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().optional(),
});
export type Visualization = z.infer<typeof VisualizationSchema>;

export const LayoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Layout = z.infer<typeof LayoutSchema>;

export const PanelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("visualization"),
    id: z.string().optional(),
    viz_id: z.string().min(1),
    layout: LayoutSchema.optional(),
    title_override: z.string().optional(),
  }),
  z.object({
    kind: z.literal("markdown"),
    id: z.string().optional(),
    content: z.string(),
    layout: LayoutSchema.optional(),
  }),
  z.object({
    kind: z.literal("divider"),
    id: z.string().optional(),
    label: z.string().optional(),
  }),
]);
export type Panel = z.infer<typeof PanelSchema>;

export const DashboardSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  panels: z.array(PanelSchema).default([]),
  /** Dashboard-level filters: consumers pass these into each panel's
   * execute call (the fan-out is client-side, as in the legacy gateway). */
  filters: z.array(FilterSchema).default([]),
  time_range: TimeRangeSchema.optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
  /** Binds a dashboard to a conversation thread. Stored and round-tripped
   * for parity; wiring it to a live thread is the consumer's UI concern. */
  chat_thread_id: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().optional(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

// ── input shapes (lenient create: server fills identity and defaults) ─────

const VIZ_SERVER_FIELDS = ["id", "created_at", "updated_at"] as const;

export const NewVisualizationSchema = VisualizationSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  id: z.string().optional(),
});
/** Input type: fields with defaults are optional — the parse fills them. */
export type NewVisualization = z.input<typeof NewVisualizationSchema>;

export const NewDashboardSchema = DashboardSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  id: z.string().optional(),
});
export type NewDashboard = z.input<typeof NewDashboardSchema>;

export function newVisualization(input: NewVisualization): Visualization {
  const now = new Date().toISOString();
  return VisualizationSchema.parse({
    ...input,
    id: input.id ?? `viz-${randomUUID()}`,
    created_at: now,
    updated_at: now,
  });
}

export function newDashboard(input: NewDashboard): Dashboard {
  const now = new Date().toISOString();
  return DashboardSchema.parse({
    ...input,
    id: input.id ?? `dash-${randomUUID()}`,
    created_at: now,
    updated_at: now,
  });
}

/** RFC 7396 JSON Merge Patch: null removes a key, objects merge deep,
 * arrays and scalars replace. `id`, `schema_version`, `created_at`, and
 * `created_by` are protected from mutation. */
export function mergePatch<T extends Record<string, unknown>>(doc: T, patch: unknown): T {
  const merged = applyMergePatch(doc, patch) as Record<string, unknown>;
  for (const key of [...VIZ_SERVER_FIELDS, "schema_version", "created_by"]) {
    if (key in doc) merged[key] = doc[key];
  }
  merged.updated_at = new Date().toISOString();
  return merged as T;
}

function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const base: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}
