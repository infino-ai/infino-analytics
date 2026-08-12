import { useEffect, useState } from "react";
import {
  createDashboard,
  deleteVisualization,
  executeVisualization,
  listDashboards,
  listVisualizations,
  patchDashboard,
  type ExecuteResult,
  type Visualization,
} from "./api";
import { ChartCard } from "./Chart";

// The visualization library: every saved chart, executed live. Each card is
// a round trip through the persistence contract — the stored spec runs
// through the same execute path a dashboard panel uses.

const DEFAULT_DASHBOARD_TITLE = "Pinned dashboard";

type CellState = { result?: ExecuteResult; error?: string };

export default function VizPage() {
  const [items, setItems] = useState<Visualization[] | null>(null);
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [added, setAdded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    listVisualizations()
      .then((vizzes) => {
        if (cancelled) return;
        setItems(vizzes);
        for (const v of vizzes) {
          executeVisualization(v.id)
            .then((result) => !cancelled && setCells((c) => ({ ...c, [v.id]: { result } })))
            .catch(
              (err) =>
                !cancelled &&
                setCells((c) => ({ ...c, [v.id]: { error: String(err.message ?? err) } })),
            );
        }
      })
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function remove(id: string) {
    await deleteVisualization(id).catch(() => {});
    setItems((v) => (v ? v.filter((x) => x.id !== id) : v));
  }

  // Append to the default dashboard (created on first use), auto-flowing a
  // two-column layout on the 48-column grid.
  async function addToDashboard(vizId: string) {
    const dashboards = await listDashboards();
    let dash = dashboards.find((d) => d.title === DEFAULT_DASHBOARD_TITLE);
    dash ??= await createDashboard({ title: DEFAULT_DASHBOARD_TITLE });
    const n = dash.panels.length;
    const panels = [
      ...dash.panels,
      {
        kind: "visualization" as const,
        viz_id: vizId,
        layout: { x: (n % 2) * 24, y: Math.floor(n / 2) * 18, w: 24, h: 18 },
      },
    ];
    // Merge-patch replaces arrays whole, so send the full panel list.
    await patchDashboard(dash.id, { panels });
    setAdded((a) => ({ ...a, [vizId]: true }));
  }

  if (items === null) return <div className="page pagenote">loading…</div>;

  return (
    <div className="page">
      {items.length === 0 && (
        <div className="empty">
          <div className="big">
            No saved <em>visualizations</em> yet.
          </div>
          <div>
            pin a chart from a chat answer, or POST a VizSpec to /visualizations
          </div>
        </div>
      )}

      <div className="vizgrid">
        {items.map((v) => {
          const cell = cells[v.id];
          return (
            <div className="vizcell" key={v.id}>
              {cell?.result ? (
                <ChartCard
                  event={{ type: "chart", spec: v, result: cell.result }}
                  actions={
                    <>
                      <button
                        className="cardaction"
                        disabled={added[v.id]}
                        title={`Add to "${DEFAULT_DASHBOARD_TITLE}"`}
                        onClick={() => addToDashboard(v.id)}
                      >
                        {added[v.id] ? "added ✓" : "+ dashboard"}
                      </button>
                      <button className="cardaction" title="Delete" onClick={() => remove(v.id)}>
                        delete
                      </button>
                    </>
                  }
                />
              ) : cell?.error ? (
                <div className="card">
                  <div className="card-head">
                    <span className="card-title">{v.title}</span>
                    <button className="cardaction" onClick={() => remove(v.id)}>
                      delete
                    </button>
                  </div>
                  <div className="card-body">
                    <div className="error">{cell.error}</div>
                  </div>
                </div>
              ) : (
                <div className="card">
                  <div className="card-head">
                    <span className="card-title">{v.title}</span>
                    <span className="card-kind">{v.chart.type}</span>
                  </div>
                  <div className="card-body pagenote">executing…</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
