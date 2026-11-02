import { fileURLToPath } from "node:url";
import type { EmbeddingConfig } from "./client.js";
import { embeddingEnv } from "./embedding.js";
import { QUERY_POLICY_ENV, policyPath } from "./query-policy.mjs";
export {
  VizSpecSchema,
  SqlSourceSchema,
  MappingSchema,
  CHART_TYPES,
} from "./spec.js";
export type {
  VizSpec,
  SqlSource,
  Mapping,
  ChartType,
  Binding,
  Warning,
  ExecuteResult,
} from "./spec.js";
export type { ChatEvent } from "./events.js";
export { drain, stepDetail, stepResult, STEP_RESULT_MAX } from "./events.js";
export { buildSystemPrompt } from "./prompt.js";
export type { PromptCapabilities } from "./prompt.js";
export type { AgentHarness, HarnessRunParams, HarnessRunResult } from "./harness.js";
export { InfinoClient } from "./client.js";
export type { InfinoConfig, EmbeddingConfig } from "./client.js";
export { embeddingEnv, parseEmbeddingConfig, probeEmbedding } from "./embedding.js";
export type { EmbeddingProbe } from "./embedding.js";
export { execute } from "./execute.js";
export { CREATE_CHART_INPUT, CREATE_CHART_DESCRIPTION, runCreateChart } from "./chart-tool.js";
export type { CreateChartArgs } from "./chart-tool.js";
export { InMemoryStorage, isPersistentEvent, memoryDocStore } from "./storage.js";
export type {
  StorageAdapter,
  ThreadStore,
  DocStore,
  Thread,
  StoredMessage,
  NewMessage,
} from "./storage.js";
export {
  FILTER_OPERATORS,
  FilterSchema,
  TimeRangeSchema,
  VisualizationSchema,
  DashboardSchema,
  PanelSchema,
  LayoutSchema,
  NewVisualizationSchema,
  NewDashboardSchema,
  newVisualization,
  newDashboard,
  mergePatch,
} from "./viz.js";
export type {
  Filter,
  FilterOperator,
  TimeRange,
  Visualization,
  Dashboard,
  Panel,
  Layout,
  NewVisualization,
  NewDashboard,
} from "./viz.js";
export { injectFilters, mergeFilters, timeRangeFilter } from "./filters.js";
export type { InjectionResult } from "./filters.js";
export type { ExecuteOptions } from "./execute.js";

/** Path to the read-only filter every harness starts the Infino MCP server
 * through: `node <MCP_READONLY_PROXY> <server entry>`. Only read tools reach
 * the agent; see mcp-readonly.mjs. */
export const MCP_READONLY_PROXY = fileURLToPath(new URL("./mcp-readonly.mjs", import.meta.url));

export { QUERY_POLICY_ENV, checkQuery, loadQueryPolicy, refusalText } from "./query-policy.mjs";
export type { QueryPolicy } from "./query-policy.mjs";

/** The environment every harness starts the read-only filter with: the
 * database and its key, the deployment's query policy (FINO_QUERY_POLICY, as
 * an absolute path), and the embedder: `embedding` when set (see embeddingEnv),
 * else the server's INFINO_MCP_EMBED_* settings, so a table whose vectors came
 * from a remote model is searched with that same model. Nothing else from this
 * process reaches it. */
export function mcpServerEnv(
  databaseUri: string,
  apiKey: string,
  embedding?: EmbeddingConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { INFINO_MCP_URI: databaseUri, INFINO_API_KEY: apiKey };
  if (embedding) {
    Object.assign(out, embeddingEnv(embedding));
  } else {
    for (const [key, value] of Object.entries(env)) {
      if (/^INFINO_MCP_EMBED_/.test(key) && value) out[key] = value;
    }
  }
  const policy = policyPath(env);
  if (policy) out[QUERY_POLICY_ENV] = policy;
  return out;
}
