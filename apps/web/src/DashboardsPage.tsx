import { useEffect, useState } from "react";
import {
  deleteDashboard,
  executeVisualization,
  getDashboard,
  listDashboards,
  listVisualizations,
  type Dashboard,
  type ExecuteResult,
  type Visualization,
} from "./api";
import { ChartCard } from "./Chart";
import { Md } from "./ui";

// Dashboards, rendered per the contract: the client fans out one execute
// per visualization panel (with the dashboard's filters and time range) and
// lays panels on the 48-column grid. Widths are honored; heights flow with
// content — a reference renderer, not a layout editor.

export default function DashboardsPage({ dashId }: { dashId?: string }) {
  return dashId ? <DashboardView id={dashId} /> : <DashboardList />;
}

function DashboardList() {
  const [items, setItems] = useState<Dashboard[] | null>(null);

  useEffect(() => {
    listDashboards().then(setItems).catch(() => setItems([]));
  }, []);

  async function remove(id: string) {
    await deleteDashboard(id).catch(() => {});
    setItems((d) => (d ? d.filter((x) => x.id !== id) : d));
  }

  if (items === null) return <div className="page pagenote">loading…</div>;

  return (
    <div className="page">
      {items.length === 0 ? (
        <div className="empty">
          <div className="big">
            No <em>dashboards</em> yet.
          </div>
          <div>add a saved visualization to a dashboard, or POST to /dashboards</div>
        </div>
      ) : (
        <div className="dashlist">
          {items.map((d) => (
            <div className="dashitem" key={d.id}>
              <a className="dashopen" href={`#/dashboards/${d.id}`}>
                <span className="dashtitle">{d.title}</span>
                <span className="dashmeta">
                  {d.panels.length} panel{d.panels.length === 1 ? "" : "s"}
                </span>
              </a>
              <button className="cardaction" onClick={() => remove(d.id)} title="Delete">
                delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardView({ id }: { id: string }) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [vizzes, setVizzes] = useState<Map<string, Visualization>>(new Map());
  const [results, setResults] = useState<Record<string, ExecuteResult | { error: string }>>({});
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d: Dashboard;
      try {
        d = await getDashboard(id);
      } catch {
        if (!cancelled) setMissing(true);
        return;
      }
      if (cancelled) return;
      setDash(d);
      const ids = d.panels.flatMap((p) => (p.kind === "visualization" ? [p.viz_id] : []));
      const docs = await listVisualizations();
      if (cancelled) return;
      setVizzes(new Map(docs.filter((v) => ids.includes(v.id)).map((v) => [v.id, v])));
      // The fan-out: one execute per panel, dashboard filters + time range
      // applied to each.
      for (const vizId of ids) {
        executeVisualization(vizId, { filters: d.filters, time_range: d.time_range })
          .then((r) => !cancelled && setResults((x) => ({ ...x, [vizId]: r })))
          .catch(
            (err) =>
              !cancelled &&
              setResults((x) => ({ ...x, [vizId]: { error: String(err.message ?? err) } })),
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (missing)
    return (
      <div className="page pagenote">
        unknown dashboard — <a href="#/dashboards">back to the list</a>
      </div>
    );
  if (!dash) return <div className="page pagenote">loading…</div>;

  return (
    <div className="page">
      <div className="dashhead">
        <a className="dashback" href="#/dashboards">
          ← dashboards
        </a>
        <h1 className="dashname">{dash.title}</h1>
        {dash.time_range && (
          <span className="dashmeta">
            {String(dash.time_range.from)} → {String(dash.time_range.to)}
          </span>
        )}
      </div>

      <div className="dashgrid">
        {dash.panels.map((panel, i) => {
          const w = panel.kind === "divider" ? 48 : (panel.layout?.w ?? 24);
          const style = { gridColumn: `span ${Math.max(1, Math.min(48, w))}` };
          if (panel.kind === "markdown") {
            return (
              <div className="panel panel-md" style={style} key={panel.id ?? i}>
                <Md text={panel.content} />
              </div>
            );
          }
          if (panel.kind === "divider") {
            return (
              <div className="panel panel-divider" style={style} key={panel.id ?? i}>
                {panel.label && <span>{panel.label}</span>}
              </div>
            );
          }
          const viz = vizzes.get(panel.viz_id);
          const res = results[panel.viz_id];
          return (
            <div className="panel" style={style} key={panel.id ?? i}>
              {viz && res && !("error" in res) ? (
                <ChartCard
                  event={{
                    type: "chart",
                    spec: panel.title_override ? { ...viz, title: panel.title_override } : viz,
                    result: res,
                  }}
                />
              ) : res && "error" in res ? (
                <div className="error">{res.error}</div>
              ) : (
                <div className="pagenote">executing…</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
