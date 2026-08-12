import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ChartEvent } from "./api";

// The worked example of the render contract: read ONLY metadata.binding to
// find columns — never derive names from the SQL or the spec, the server
// already resolved them against the actual result.

// Dark-theme chart palette. Kept in sync with the CSS tokens in styles.css
// (same names, same intent). Series colors are lifted for legibility on the
// near-black ground; the first is the vermilion accent.
const PALETTE = ["#f0532f", "#6f9aff", "#3fbf8f", "#c88ae0", "#e8b34a", "#c9c7c0"];
const AXIS_COLOR = "#66655f";
const SPLIT_COLOR = "#2c2c33";
const INK = "#e9e7e1";
const SURFACE = "#1f1f25";
const MAX_TABLE_ROWS = 50;

const nf = new Intl.NumberFormat("en-US");
const nfCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });


export function ChartCard({ event }: { event: ChartEvent }) {
  const { spec, result } = event;
  const kind = spec.chart.type;
  const warnings = result.metadata.warnings;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{spec.title}</span>
        <span className="card-kind">{kind}</span>
      </div>
      <div className="card-body">
        {kind === "metric" ? (
          <Metric event={event} />
        ) : kind === "table" ? (
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

  return <div ref={ref} style={{ width: "100%", height: 300 }} />;
}

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
      borderColor: "#3d3d45",
      borderWidth: 1,
      extraCssText: "box-shadow: 0 2px 10px rgba(0,0,0,0.4); border-radius: 4px;",
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

  // bar | line | area — categorical/temporal x, one or more numeric series.
  const x = binding.x as string;
  const categories = [...new Set(rows.map((r) => String(r[x])))];

  let series: echarts.SeriesOption[];
  if (binding.series) {
    // Long → wide: one series per distinct value of the series column.
    const s = binding.series;
    const y = binding.y[0];
    const names = [...new Set(rows.map((r) => String(r[s])))];
    series = names.map((name) => ({
      name,
      type: kind === "bar" ? "bar" : "line",
      areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
      smooth: kind !== "bar" ? 0.15 : undefined,
      showSymbol: false,
      data: categories.map((cat) => {
        const row = rows.find((r) => String(r[x]) === cat && String(r[s]) === name);
        return row ? Number(row[y]) : null;
      }),
    }));
  } else {
    series = binding.y.map((y) => ({
      name: y,
      type: kind === "bar" ? "bar" : "line",
      areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
      smooth: kind !== "bar" ? 0.15 : undefined,
      showSymbol: false,
      barMaxWidth: 34,
      data: categories.map((cat) => {
        const row = rows.find((r) => String(r[x]) === cat);
        return row ? Number(row[y]) : null;
      }),
    }));
  }

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
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
      axisLabel: {
        color: AXIS_COLOR,
        fontSize: 10.5,
        formatter: (v: number) => (Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v)),
      },
    },
    series,
  };
}
