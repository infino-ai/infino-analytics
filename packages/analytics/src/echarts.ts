import type { ExecuteResult, VizSpec } from "@infino-ai/analytics-core";

// The reference renderer as a pure function: a stored visualization (or any
// VizSpec) plus its executed result, in; something a chart library accepts,
// out. This is how "render it in your own frontend" works without writing
// mapping code — the same role the classic SDK's option helper played.
//
// It reads ONLY result.metadata.binding to find columns — never the SQL,
// never raw aliases — which is the render contract everything else in the
// kit follows. Call it wherever suits your architecture: in your backend
// (ship plan.option to the browser as JSON) via the package's main entry,
// or in the browser via "@infino-ai/analytics/echarts", an entry that
// carries no server code.
//
// This file must stay dependency-free and browser-safe: types from the
// contract layer only, no echarts import (the option is plain JSON), no
// Node built-ins.

/** What to render. `echarts` plans go straight to echarts.setOption();
 * `table` and `metric` are yours to lay out (a chart library would only
 * get in the way). */
export type RenderPlan =
  | { kind: "echarts"; option: Record<string, unknown> }
  | { kind: "table"; columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }
  | {
      kind: "metric";
      value: number | null;
      label: string;
      /** Value formatted with the spec's metric_format applied. */
      text: string;
    };

/** Colors and type faces; override any subset to match your design system. */
export interface ChartTheme {
  /** Series colors, first is the emphasis color. */
  palette: string[];
  axisColor: string;
  splitLineColor: string;
  /** Primary text color (labels, legends). */
  ink: string;
  /** Tooltip / pie-border surface color. */
  surface: string;
  /** Tooltip border color. */
  border: string;
  /** Sequential ramp for heatmap cells, low → high. */
  heatRamp: string[];
  fontFamily: string;
}

const DEFAULT_THEME: ChartTheme = {
  palette: ["#d23b1e", "#2b50aa", "#1f8a70", "#8f3e97", "#c98a00", "#1b1b1f"],
  axisColor: "#97968f",
  splitLineColor: "#e8e6dd",
  ink: "#1b1b1f",
  surface: "#ffffff",
  border: "#d8d6cd",
  heatRamp: ["#fdf2ee", "#f6c9ba", "#eb9a80", "#d23b1e", "#7e2312"],
  fontFamily: "Fragment Mono, ui-monospace, monospace",
};

const nf = new Intl.NumberFormat("en-US");
const nfCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtNum = (v: number) => (Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v));

/** Map a visualization + its executed result to a render plan. Pure
 * function, no network. Unresolvable grids/scatters degrade to a table —
 * the data always renders as something. */
export function toEChartsOption(
  spec: Pick<VizSpec, "chart" | "options">,
  result: ExecuteResult,
  theme: Partial<ChartTheme> = {},
): RenderPlan {
  const t: ChartTheme = { ...DEFAULT_THEME, ...theme };
  const kind = spec.chart.type;
  const { binding } = result.metadata;
  const rows = result.rows;

  if (kind === "metric") {
    const col = binding.value;
    const raw = col ? rows[0]?.[col] : undefined;
    const value = typeof raw === "number" ? raw : Number(raw ?? NaN);
    const fmt = spec.options?.metric_format;
    const text = Number.isFinite(value)
      ? `${fmt?.prefix ?? ""}${fmtNum(value)}${fmt?.suffix ?? ""}`
      : "—";
    return {
      kind: "metric",
      value: Number.isFinite(value) ? value : null,
      label: col ?? "",
      text,
    };
  }

  const unrenderable =
    (kind === "heatmap" && (!binding.x || !binding.series || binding.y.length === 0)) ||
    (kind === "scatter" && (!binding.x || binding.y.length === 0)) ||
    (kind !== "table" && (!binding.x || binding.y.length === 0));
  if (kind === "table" || unrenderable) {
    return { kind: "table", columns: result.columns, rows };
  }

  const base: Record<string, unknown> = {
    color: t.palette,
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.fontFamily, color: t.axisColor },
    tooltip: {
      trigger: kind === "pie" ? "item" : "axis",
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      textStyle: { color: t.ink, fontSize: 12, fontFamily: t.fontFamily },
    },
    grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
  };

  const categoryAxis = (data: string[]) => ({
    type: "category",
    data,
    axisLine: { lineStyle: { color: t.ink } },
    axisLabel: { color: t.axisColor, fontSize: 10.5, hideOverlap: true },
    axisTick: { show: false },
  });
  const valueAxis = (extra: Record<string, unknown> = {}) => ({
    type: "value",
    splitLine: { lineStyle: { color: t.splitLineColor } },
    axisLabel: { color: t.axisColor, fontSize: 10.5, formatter: fmtNum },
    ...extra,
  });
  const legend = (count: number, icon = "rect") =>
    count > 1
      ? { top: 0, textStyle: { color: t.ink, fontSize: 11 }, icon, itemWidth: 10, itemHeight: 3 }
      : { show: false };

  if (kind === "pie") {
    const x = binding.x as string;
    const y = binding.y[0];
    return {
      kind: "echarts",
      option: {
        ...base,
        legend: { show: false },
        series: [
          {
            type: "pie",
            radius: ["40%", "68%"],
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
            label: { color: t.ink, fontSize: 11, fontFamily: t.fontFamily },
            data: rows.map((r) => ({ name: String(r[x]), value: Number(r[y]) })),
          },
        ],
      },
    };
  }

  if (kind === "heatmap") {
    // Grid: x = column axis, series = row axis, y[0] = cell value.
    const x = binding.x as string;
    const s = binding.series as string;
    const v = binding.y[0];
    const xCats = [...new Set(rows.map((r) => String(r[x])))];
    const yCats = [...new Set(rows.map((r) => String(r[s])))];
    const data = rows.map((r) => [
      xCats.indexOf(String(r[x])),
      yCats.indexOf(String(r[s])),
      Number(r[v]),
    ]);
    const values = data.map((d) => d[2] as number).filter(Number.isFinite);
    const max = values.length ? Math.max(...values) : 1;
    const min = values.length ? Math.min(...values, 0) : 0;
    return {
      kind: "echarts",
      option: {
        ...base,
        grid: { left: 8, right: 16, top: 10, bottom: 56, containLabel: true },
        xAxis: {
          type: "category",
          data: xCats,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.axisColor, fontSize: 10.5, hideOverlap: true },
        },
        yAxis: {
          type: "category",
          data: yCats,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.axisColor, fontSize: 10.5 },
        },
        visualMap: {
          min,
          max,
          calculable: false,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          inRange: { color: t.heatRamp },
          textStyle: { color: t.axisColor, fontSize: 10 },
          itemHeight: 90,
        },
        series: [
          {
            type: "heatmap",
            data,
            label:
              xCats.length * yCats.length <= 220
                ? {
                    show: true,
                    fontSize: 9.5,
                    fontFamily: t.fontFamily,
                    color: t.ink,
                    formatter: (p: { value?: unknown }) => {
                      const val = Array.isArray(p.value) ? Number(p.value[2]) : NaN;
                      return Number.isFinite(val) ? fmtNum(val) : "";
                    },
                  }
                : { show: false },
            itemStyle: { borderColor: t.surface, borderWidth: 1.5 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          },
        ],
      },
    };
  }

  if (kind === "scatter") {
    // Numeric x vs numeric y; series (optional) colors point groups.
    const x = binding.x as string;
    const y = binding.y[0];
    const axis = (name: string) =>
      valueAxis({
        name,
        nameTextStyle: { color: t.axisColor, fontSize: 10 },
        axisLine: { show: false },
      });
    const groups = binding.series
      ? [...new Set(rows.map((r) => String(r[binding.series as string])))]
      : [null];
    return {
      kind: "echarts",
      option: {
        ...base,
        legend: legend(groups[0] === null ? 1 : groups.length, "circle"),
        grid: { left: 8, right: 20, top: 30, bottom: 8, containLabel: true },
        xAxis: axis(x),
        yAxis: axis(y),
        series: groups.map((g) => ({
          name: g ?? y,
          type: "scatter",
          symbolSize: 9,
          itemStyle: { opacity: 0.75 },
          data: rows
            .filter((r) => (g === null ? true : String(r[binding.series as string]) === g))
            .map((r) => [Number(r[x]), Number(r[y])]),
        })),
      },
    };
  }

  // bar | horizontalBar | line | area | combo — categorical x; y[] on the
  // primary axis, y2[] on a secondary axis (combo: y bars + y2 lines).
  const x = binding.x as string;
  const categories = [...new Set(rows.map((r) => String(r[x])))];
  const horizontal = kind === "horizontalBar";
  const primaryType = kind === "combo" || kind === "bar" || horizontal ? "bar" : "line";
  // A second value axis needs the standard orientation; in horizontal mode
  // y2 columns just join the primary axis.
  const hasSecondAxis = !binding.series && binding.y2.length > 0 && !horizontal;

  const valueFor = (y: string) =>
    categories.map((cat) => {
      const row = rows.find((r) => String(r[x]) === cat);
      return row ? Number(row[y]) : null;
    });

  let series: Record<string, unknown>[];
  if (binding.series) {
    // Long → wide: one series per distinct value of the series column.
    const s = binding.series;
    const y = binding.y[0];
    const names = [...new Set(rows.map((r) => String(r[s])))];
    series = names.map((name) => ({
      name,
      type: primaryType,
      areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
      smooth: primaryType !== "bar" ? 0.15 : undefined,
      showSymbol: false,
      data: categories.map((cat) => {
        const row = rows.find((r) => String(r[x]) === cat && String(r[s]) === name);
        return row ? Number(row[y]) : null;
      }),
    }));
  } else {
    series = [
      ...binding.y.map((y) => ({
        name: y,
        type: primaryType,
        yAxisIndex: 0,
        areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
        smooth: primaryType !== "bar" ? 0.15 : undefined,
        showSymbol: false,
        barMaxWidth: 34,
        data: valueFor(y),
      })),
      // Secondary-axis overlays always render as lines: the second scale
      // reads as a trace over the primary shape.
      ...binding.y2.map((y) => ({
        name: y,
        type: horizontal ? primaryType : "line",
        yAxisIndex: hasSecondAxis ? 1 : 0,
        smooth: !horizontal ? 0.15 : undefined,
        showSymbol: false,
        lineStyle: !horizontal ? { width: 2.5 } : undefined,
        data: valueFor(y),
      })),
    ];
  }

  const catAxis = categoryAxis(categories);
  const primaryValueAxis = valueAxis();
  const secondValueAxis = valueAxis({ splitLine: { show: false } });

  return {
    kind: "echarts",
    option: {
      ...base,
      legend: legend(series.length),
      // horizontalBar swaps the axes: categories on y, values on x.
      xAxis: horizontal ? primaryValueAxis : catAxis,
      yAxis: horizontal
        ? catAxis
        : hasSecondAxis
          ? [primaryValueAxis, secondValueAxis]
          : primaryValueAxis,
      series,
    },
  };
}
