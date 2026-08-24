import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CHART_TYPES,
  InfinoClient,
  VizSpecSchema,
  execute,
  type ChatEvent,
  type ExecuteResult,
  type VizSpec,
} from "@infino-ai/analytics-core";


// How much of a chart's data the MODEL sees. The full rows ride the event
// stream to the UI; the model gets a compact receipt so large results never
// inflate its context.
const MODEL_SAMPLE_ROWS = 5;

const CreateChartInput = {
  title: z.string().describe("Short human title for the chart"),
  chart_type: z
    .enum(CHART_TYPES)
    .describe("bar | horizontalBar | line | area | pie | metric | table | heatmap | scatter | combo"),
  table: z.string().describe("Source table name"),
  sql: z.string().describe("The SELECT that produces the chart's data. Alias every aggregate."),
  x: z.string().optional().describe("Result column for the x axis / category (heatmap: column axis; scatter: numeric)"),
  y: z.array(z.string()).optional().describe("Numeric result column(s) for the y axis / value (heatmap: the cell value)"),
  y2: z
    .array(z.string())
    .optional()
    .describe("Numeric column(s) on a secondary RIGHT axis (different unit/scale); combo renders them as lines over the y bars"),
  series: z.string().optional().describe("Result column that splits into one series per value (heatmap: the row axis)"),
  time_column: z.string().optional().describe("ISO timestamp column of the source table, if any"),
};

/** Build the in-process MCP server carrying the app-specific tools.
 * `emit` pushes events onto the chat stream (bypassing the model — full
 * chart data goes to the UI, a compact summary goes back to the model). */
export function buildLocalTools(client: InfinoClient, emit: (e: ChatEvent) => void) {
  const createChart = tool(
    "create_chart",
    "Execute a SQL query and render the result to the user as a chart or table — the ONLY way to show data to the user. Chart intuition: single number → metric; time on x → line/area; categories → bar, or horizontalBar when category names are long or it is a ranking (bounded with a top-N LIMIT so it stays readable); proportions under ~8 slices → pie; raw records → table; two categorical dimensions + one measure (hour × weekday, feature × bucket) → heatmap with x = column axis, series = row axis, y = the cell value (SQL returns one row per cell); relationship between two numeric measures → scatter with numeric x and y, optional series to color point groups; a measure and a rate/price on different scales → combo (or line/bar) with y on the left axis and y2 on the right — y2 renders as lines over combo's y bars. The chart SQL may use the engine's keyword search table functions (e.g. bm25_search('table','text_col','terms', k) as a FROM relation) to rank and aggregate search hits — but not the vector/hybrid functions, which need a query vector this tool cannot embed. The x/y/y2/series mapping must use the EXACT column aliases from the SELECT (alias every aggregate, e.g. COUNT(*) AS n) — the renderer binds by result-column name. Returns the resolved binding, row count, warnings, and a small sample; warnings mean adjust the SQL or mapping and call again.",
    CreateChartInput,
    async (args) => {
      const parsed = VizSpecSchema.safeParse({
        title: args.title,
        source: {
          kind: "sql",
          table: args.table,
          raw_query: args.sql,
          time_column: args.time_column,
        },
        chart: { type: args.chart_type },
        mapping: { x: args.x, y: args.y ?? [], y2: args.y2 ?? [], series: args.series },
      } satisfies Record<string, unknown>);
      if (!parsed.success) {
        return errorResult(`invalid chart spec: ${parsed.error.message.slice(0, 400)}`);
      }
      const spec: VizSpec = parsed.data;

      emit({ type: "sql", query: spec.source.raw_query });

      let result: ExecuteResult;
      try {
        result = await execute(client, spec);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`query failed: ${message}`);
      }

      emit({ type: "chart", spec, result });

      const receipt = {
        rendered: true,
        row_count: result.metadata.row_count,
        binding: result.metadata.binding,
        warnings: result.metadata.warnings,
        columns: result.columns,
        sample_rows: result.rows.slice(0, MODEL_SAMPLE_ROWS),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // Discovery, grounding, and exploration (list tables, schema, sampling via
  // SQL, BM25/hybrid search) all come from the published
  // @infino-ai/mcp-server. The app-specific surface is exactly one tool: the
  // chart contract — the structured channel through which the agent's
  // answers become product artifacts.
  return createSdkMcpServer({
    name: "fino",
    version: "0.0.0",
    tools: [createChart],
  });
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

