import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Binding, ExecuteResult, VizSpec } from "@infino-ai/analytics-core";
import { toEChartsOption } from "../src/echarts.js";

const result = (
  columns: { name: string; type: string }[],
  rows: Record<string, unknown>[],
  binding: Partial<Binding> = {},
): ExecuteResult => ({
  columns,
  rows,
  metadata: {
    source_kind: "sql",
    row_count: rows.length,
    truncated: false,
    took_ms: 1,
    executed_query: "SELECT 1",
    filters_applied: [],
    filters_skipped: [],
    warnings: [],
    binding: { x: null, y: [], y2: [], series: null, value: null, ...binding },
  },
});

const spec = (type: VizSpec["chart"]["type"], options?: VizSpec["options"]) =>
  ({ chart: { type }, options }) as Pick<VizSpec, "chart" | "options">;

const CATEGORY = [
  { name: "day", type: "string" },
  { name: "n", type: "number" },
];
const ROWS = [{ day: "mon", n: 3 }, { day: "tue", n: 5 }];

describe("toEChartsOption", () => {
  it("builds an echarts option for a bar chart", () => {
    const plan = toEChartsOption(spec("bar"), result(CATEGORY, ROWS, { x: "day", y: ["n"] }));
    strictEqual(plan.kind, "echarts");
    ok(plan.kind === "echarts");
    deepStrictEqual((plan.option.xAxis as { data: string[] }).data, ["mon", "tue"]);
  });

  // The load-bearing contract: columns come from the binding, never from the
  // SQL or the spec's own names.
  it("reads columns only from result.metadata.binding", () => {
    const renamed = [{ DAY: "mon", N: 3 }, { DAY: "tue", N: 5 }];
    const plan = toEChartsOption(
      spec("bar"),
      result([{ name: "DAY", type: "string" }, { name: "N", type: "number" }], renamed, {
        x: "DAY",
        y: ["N"],
      }),
    );
    ok(plan.kind === "echarts");
    deepStrictEqual((plan.option.xAxis as { data: string[] }).data, ["mon", "tue"]);
  });

  it("falls back to a table when the binding cannot resolve", () => {
    const plan = toEChartsOption(spec("bar"), result(CATEGORY, ROWS));
    strictEqual(plan.kind, "table");
    ok(plan.kind === "table");
    deepStrictEqual(plan.rows, ROWS);
    deepStrictEqual(plan.columns, CATEGORY);
  });

  it("renders a table chart as a table", () => {
    const plan = toEChartsOption(spec("table"), result(CATEGORY, ROWS, { x: "day", y: ["n"] }));
    strictEqual(plan.kind, "table");
  });

  it("falls back to a table for a heatmap with no row axis", () => {
    const plan = toEChartsOption(spec("heatmap"), result(CATEGORY, ROWS, { x: "day", y: ["n"] }));
    strictEqual(plan.kind, "table");
  });

  it("formats a metric with its prefix and suffix", () => {
    const plan = toEChartsOption(
      spec("metric", { metric_format: { prefix: "$", suffix: "/mo" } }),
      result([{ name: "total", type: "number" }], [{ total: 1234 }], { value: "total" }),
    );
    ok(plan.kind === "metric");
    strictEqual(plan.value, 1234);
    strictEqual(plan.text, "$1,234/mo");
  });

  it("renders an em dash for a metric with no resolvable value", () => {
    const plan = toEChartsOption(spec("metric"), result([], [], {}));
    ok(plan.kind === "metric");
    strictEqual(plan.value, null);
    strictEqual(plan.text, "—");
  });

  it("puts y2 on a second value axis", () => {
    const plan = toEChartsOption(
      spec("combo"),
      result(
        [...CATEGORY, { name: "rate", type: "number" }],
        [{ day: "mon", n: 3, rate: 0.5 }],
        { x: "day", y: ["n"], y2: ["rate"] },
      ),
    );
    ok(plan.kind === "echarts");
    strictEqual((plan.option.yAxis as unknown[]).length, 2);
  });

  it("is pure — it does not mutate the result it is given", () => {
    const r = result(CATEGORY, ROWS, { x: "day", y: ["n"] });
    const before = JSON.stringify(r);
    toEChartsOption(spec("bar"), r);
    strictEqual(JSON.stringify(r), before);
  });
});
