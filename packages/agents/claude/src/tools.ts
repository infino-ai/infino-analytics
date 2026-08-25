import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  CREATE_CHART_DESCRIPTION,
  CREATE_CHART_INPUT,
  InfinoClient,
  runCreateChart,
  type ChatEvent,
} from "@infino-ai/analytics-core";

/** Build the in-process MCP server carrying the app-specific tools.
 * `emit` pushes events onto the chat stream (bypassing the model — full
 * chart data goes to the UI, a compact summary goes back to the model). */
export function buildLocalTools(client: InfinoClient, emit: (e: ChatEvent) => void) {
  const createChart = tool(
    "create_chart",
    CREATE_CHART_DESCRIPTION,
    CREATE_CHART_INPUT,
    async (args) => {
      const outcome = await runCreateChart(client, args, emit);
      return outcome.ok
        ? { content: [{ type: "text" as const, text: outcome.receipt }] }
        : { content: [{ type: "text" as const, text: outcome.error }], isError: true };
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
