import { z } from "zod";
import {
  CREATE_CHART_DESCRIPTION,
  CREATE_CHART_INPUT,
  runCreateChart,
  type ChatEvent,
  type CreateChartArgs,
  type InfinoClient,
} from "@infino-ai/analytics-core";
import type { FunctionTool } from "openai/resources/responses/responses";
import { stripSchemaMeta, type McpToolset } from "./mcp.js";

// One dispatch table over both tool sources: the MCP data tools and the
// in-process chart contract. The model sees a flat list and never learns
// which is which.

export interface ToolRegistry {
  readonly definitions: FunctionTool[];
  /** Never throws: a bad call is the model's error to read and retry. */
  invoke(name: string, rawArgs: string): Promise<{ text: string; isError: boolean }>;
}

export function buildToolRegistry(
  mcp: McpToolset,
  client: InfinoClient,
  emit: (event: ChatEvent) => void,
): ToolRegistry {
  const definitions = [...mcp.tools, createChartTool()];

  return {
    definitions,
    async invoke(name, rawArgs) {
      let args: Record<string, unknown>;
      try {
        args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        return { text: `invalid tool arguments (not JSON): ${rawArgs.slice(0, 200)}`, isError: true };
      }
      if (name === "create_chart") {
        const outcome = await runCreateChart(client, args as CreateChartArgs, emit);
        return outcome.ok
          ? { text: outcome.receipt, isError: false }
          : { text: outcome.error, isError: true };
      }
      if (!mcp.tools.some((t) => t.name === name)) {
        return { text: `unknown tool: ${name}`, isError: true };
      }
      return mcp.call(name, args);
    },
  };
}

/** The chart contract as a Responses function tool. `reused: "inline"` keeps
 * `$ref`/`$defs` out — Azure's validator does not follow them. */
function createChartTool(): FunctionTool {
  const schema = z.toJSONSchema(z.object(CREATE_CHART_INPUT), {
    target: "draft-07",
    io: "input",
    reused: "inline",
  });
  return {
    type: "function",
    name: "create_chart",
    description: CREATE_CHART_DESCRIPTION,
    parameters: stripSchemaMeta(schema as Record<string, unknown>),
    strict: false,
  };
}
