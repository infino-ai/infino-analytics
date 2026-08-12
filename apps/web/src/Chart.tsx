import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ChartEvent } from "./api";

// The worked example of the render contract: read ONLY metadata.binding to
// find columns — never derive names from the SQL or the spec, the server
// already resolved them against the actual result.

// Light-theme chart palette. Kept in sync with the CSS tokens in styles.css
// (same names, same intent); the first series is the vermilion accent.
const PALETTE = ["#d23b1e", "#2b50aa", "#1f8a70", "#8f3e97", "#c98a00", "#1b1b1f"];
const AXIS_COLOR = "#97968f";
const SPLIT_COLOR = "#e8e6dd";
const INK = "#1b1b1f";
const SURFACE = "#ffffff";
const MAX_TABLE_ROWS = 50;

const nf = new Intl.NumberFormat("en-US");
const nfCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });


export function ChartCard({
  event,
  actions,
}: {
  event: ChartEvent;
  /** Extra controls for the card head (pin, delete, …) — page-specific. */
  actions?: React.ReactNode;
}) {
  const { spec, result } = event;
  const kind = spec.chart.type;
  const { warnings, binding } = result.metadata;

  // Degrade-never-fail on the render side too: a grid or scatter whose
  // binding didn't resolve still shows its data as a table.
  const unrenderable =
    (kind === "heatmap" && (!binding.x || !binding.series || binding.y.length === 0)) ||
    (kind === "scatter" && (!binding.x || binding.y.length === 0));

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{spec.title}</span>
        <span className="card-kind">{kind}</span>
        {actions}
      </div>
      <div className="card-body">
        {kind === "metric" ? (
          <Metric event={event} />
        ) : kind === "table" || unrenderable ? (
          <DataTable event={event} />
        ) : (
          <Echart event={event} />
        )}
      </div>
      {warnings.length > 0 && (
        <div className="card-foot">
          <span className="warn">⚠ {warnings.map((w) => w.code).join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function Metric({ event }: { event: ChartEvent }) {
  const { result, spec } = event;
  const col = result.metadata.binding.value;
  const raw = col ? result.rows[0]?.[col] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw ?? NaN);
  const fmt = spec.options?.metric_format;
  const text = Number.isFinite(value)
    ? `${fmt?.prefix ?? ""}${Math.abs(value) >= 10000 ? nfCompact.format(value) : nf.format(value)}${fmt?.suffix ?? ""}`
    : "—";
  return (
    <div className="metric">
      <div className="value">{text}</div>
      <div className="label">{col ?? ""}</div>
    </div>
  );
}

function DataTable({ event }: { event: ChartEvent }) {
  const { result } = event;
  const cols = result.columns.map((c) => c.name);
  const rows = result.rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="tablewrap">
      <table className="data">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = row[c];
                const isNum = typeof v === "number";
                return (
                  <td key={c} className={isNum ? "num" : undefined}>
                    {isNum ? nf.format(v as number) : String(v ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Echart({ event }: { event: ChartEvent }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(buildOption(event));
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [event]);

  // Heatmaps grow with their row count so cells stay readable.
  let height = 300;
  if (event.spec.chart.type === "heatmap") {
    const s = event.result.metadata.binding.series;
    const rows = s ? new Set(event.result.rows.map((r) => String(r[s]))).size : 0;
    height = Math.min(560, Math.max(240, 120 + rows * 30));
  }

  return <div ref={ref} style={{ width: "100%", height }} />;
}

// Warm sequential ramp for heatmap cells: paper → vermilion → deep brick.
const HEAT_RAMP = ["#fdf2ee", "#f6c9ba", "#eb9a80", "#d23b1e", "#7e2312"];

function buildOption(event: ChartEvent): echarts.EChartsOption {
  const { spec, result } = event;
  const { binding } = result.metadata;
  const kind = spec.chart.type;
  const rows = result.rows;

  const base: echarts.EChartsOption = {
    color: PALETTE,
    backgroundColor: "transparent",
    textStyle: { fontFamily: "Fragment Mono, monospace", color: AXIS_COLOR },
    tooltip: {
      trigger: kind === "pie" ? "item" : "axis",
      backgroundColor: SURFACE,
      borderColor: "#d8d6cd",
      borderWidth: 1,
      extraCssText: "box-shadow: 0 2px 10px rgba(27,27,31,0.12);",
      textStyle: { color: INK, fontSize: 12, fontFamily: "Fragment Mono, monospace" },
    },
    grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
  };

  if (kind === "pie") {
    const x = binding.x as string;
    const y = binding.y[0];
    return {
      ...base,
      legend: { show: false },
      series: [
        {
          type: "pie",
          radius: ["40%", "68%"],
          itemStyle: { borderColor: SURFACE, borderWidth: 2 },
          label: { color: INK, fontSize: 11, fontFamily: "Fragment Mono, monospace" },
          data: rows.map((r) => ({ name: String(r[x]), value: Number(r[y]) })),
        },
      ],
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
      ...base,
      grid: { left: 8, right: 16, top: 10, bottom: 56, containLabel: true },
      xAxis: {
        type: "category",
        data: xCats,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: AXIS_COLOR, fontSize: 10.5, hideOverlap: true },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: yCats,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: AXIS_COLOR, fontSize: 10.5 },
      },
      visualMap: {
        min,
        max,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        inRange: { color: HEAT_RAMP },
        textStyle: { color: AXIS_COLOR, fontSize: 10 },
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
                  fontFamily: "Fragment Mono, monospace",
                  color: INK,
                  formatter: (p: { value?: unknown }) => {
                    const v = Array.isArray(p.value) ? Number(p.value[2]) : NaN;
                    if (!Number.isFinite(v)) return "";
                    return Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v);
                  },
                }
              : { show: false },
          itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
          emphasis: { itemStyle: { borderColor: INK, borderWidth: 1 } },
        },
      ],
    };
  }

  if (kind === "scatter") {
    // Numeric x vs numeric y; series (optional) colors point groups.
    const x = binding.x as string;
    const y = binding.y[0];
    const valueAxis = (name: string): echarts.XAXisComponentOption & echarts.YAXisComponentOption => ({
      type: "value",
      name,
      nameTextStyle: { color: AXIS_COLOR, fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
      axisLabel: {
        color: AXIS_COLOR,
        fontSize: 10.5,
        formatter: (v: number) => (Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v)),
      },
    });
    const groups = binding.series
      ? [...new Set(rows.map((r) => String(r[binding.series as string])))]
      : [null];
    const series = groups.map((g) => ({
      name: g ?? y,
      type: "scatter" as const,
      symbolSize: 9,
      itemStyle: { opacity: 0.75 },
      data: rows
        .filter((r) => (g === null ? true : String(r[binding.series as string]) === g))
        .map((r) => [Number(r[x]), Number(r[y])]),
    }));
    return {
      ...base,
      legend:
        groups.length > 1 && groups[0] !== null
          ? { top: 0, textStyle: { color: INK, fontSize: 11 }, icon: "circle", itemWidth: 8 }
          : { show: false },
      grid: { left: 8, right: 20, top: 30, bottom: 8, containLabel: true },
      xAxis: valueAxis(x),
      yAxis: valueAxis(y),
      series,
    };
  }

  // bar | line | area | combo — categorical/temporal x; y[] on the left
  // axis, y2[] on a right axis (combo: y bars + y2 lines).
  const x = binding.x as string;
  const categories = [...new Set(rows.map((r) => String(r[x])))];
  const leftType = kind === "combo" ? "bar" : kind === "bar" ? "bar" : "line";

  const valueFor = (y: string) =>
    categories.map((cat) => {
      const row = rows.find((r) => String(r[x]) === cat);
      return row ? Number(row[y]) : null;
    });

  let series: echarts.SeriesOption[];
  if (binding.series) {
    // Long → wide: one series per distinct value of the series column.
    const s = binding.series;
    const y = binding.y[0];
    const names = [...new Set(rows.map((r) => String(r[s])))];
    series = names.map((name) => ({
      name,
      type: leftType,
      areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
      smooth: leftType !== "bar" ? 0.15 : undefined,
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
        type: leftType,
        yAxisIndex: 0,
        areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
        smooth: leftType !== "bar" ? 0.15 : undefined,
        showSymbol: false,
        barMaxWidth: 34,
        data: valueFor(y),
      })),
      // Right axis overlays always render as lines: the second scale reads
      // as a trace over the primary shape.
      ...binding.y2.map((y) => ({
        name: y,
        type: "line" as const,
        yAxisIndex: 1,
        smooth: 0.15,
        showSymbol: false,
        lineStyle: { width: 2.5 },
        data: valueFor(y),
      })),
    ] as echarts.SeriesOption[];
  }

  const hasRightAxis = !binding.series && binding.y2.length > 0;
  const axisLabelFmt = {
    color: AXIS_COLOR,
    fontSize: 10.5,
    formatter: (v: number) => (Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v)),
  };

  return {
    ...base,
    legend:
      series.length > 1
        ? { top: 0, textStyle: { color: INK, fontSize: 11 }, icon: "rect", itemWidth: 10, itemHeight: 3 }
        : { show: false },
    xAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: INK } },
      axisLabel: { color: AXIS_COLOR, fontSize: 10.5, hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: hasRightAxis
      ? [
          { type: "value", splitLine: { lineStyle: { color: SPLIT_COLOR } }, axisLabel: axisLabelFmt },
          { type: "value", splitLine: { show: false }, axisLabel: axisLabelFmt },
        ]
      : {
          type: "value",
          splitLine: { lineStyle: { color: SPLIT_COLOR } },
          axisLabel: axisLabelFmt,
        },
    series,
  };
}
