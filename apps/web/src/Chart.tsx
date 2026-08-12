import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { toEChartsOption, type RenderPlan } from "@infino-ai/analytics/echarts";
import type { ChartEvent } from "./api";

// The worked example of consuming the package's render helper: the chart
// event (spec + executed result) goes through toEChartsOption, and this
// component just dispatches on the plan kind. The theme overrides keep the
// charts in the kit's palette; drop them and you get the same defaults.

const KIT_THEME = {
  fontFamily: "Fragment Mono, ui-monospace, monospace",
};

const MAX_TABLE_ROWS = 50;
const nf = new Intl.NumberFormat("en-US");

export function ChartCard({
  event,
  actions,
}: {
  event: ChartEvent;
  /** Extra controls for the card head (pin, delete, …) — page-specific. */
  actions?: React.ReactNode;
}) {
  const { spec, result } = event;
  const { warnings } = result.metadata;
  const plan = toEChartsOption(spec, result, KIT_THEME);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{spec.title}</span>
        <span className="card-kind">{spec.chart.type}</span>
        {actions}
      </div>
      <div className="card-body">
        {plan.kind === "metric" ? (
          <div className="metric">
            <div className="value">{plan.text}</div>
            <div className="label">{plan.label}</div>
          </div>
        ) : plan.kind === "table" ? (
          <DataTable plan={plan} />
        ) : (
          <Echart event={event} plan={plan} />
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

function DataTable({ plan }: { plan: Extract<RenderPlan, { kind: "table" }> }) {
  const cols = plan.columns.map((c) => c.name);
  const rows = plan.rows.slice(0, MAX_TABLE_ROWS);
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

function Echart({
  event,
  plan,
}: {
  event: ChartEvent;
  plan: Extract<RenderPlan, { kind: "echarts" }>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(plan.option as echarts.EChartsOption);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
