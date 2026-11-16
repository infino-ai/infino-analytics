// An optional guard over every query the agent sends, for deployments that
// need one: a public demo over a table too large to scan whole, a cost cap per
// question shape, an allow-list of tables.
//
//   FINO_QUERY_POLICY=/path/to/policy.mjs
//
// The module's default export is called before each call reaches Infino:
//
//   export default function policy({ tool, args }) {
//     // tool: an Infino MCP tool name (infino_sql, infino_keyword_search, ...)
//     //       or "create_chart"; args: that call's arguments
//     return "a reason the agent can act on"; // refuse
//     return undefined;                        // allow
//   }
//
// It may be async. A refusal goes back to the model as a tool error carrying
// the reason, so a reason that says what to do instead lets the agent retry
// within the rules. A policy that throws refuses the call: a guard that fails
// open is no guard.
//
// The read-only filter applies it to MCP calls (mcp-readonly.mjs) and the
// chart tool applies it to its SQL (chart-tool.ts). Plain JavaScript, so the
// filter can load it under any Node.
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const QUERY_POLICY_ENV = "FINO_QUERY_POLICY";

/** The policy module's path, made absolute against the current directory so
 * a child process started elsewhere loads the same file. */
export function policyPath(env = process.env) {
  const path = env[QUERY_POLICY_ENV];
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(path);
}

/** The policy function, or null when none is configured. Fails loudly when
 * one is configured but cannot load: starting without the guard would be
 * the silent kind of failure. */
export async function loadQueryPolicy(path = policyPath()) {
  if (!path) return null;
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.default !== "function") {
    throw new Error(`${QUERY_POLICY_ENV} (${path}) must default-export a function`);
  }
  return mod.default;
}

/** The policy's verdict on one call: a refusal reason, or undefined. */
export async function checkQuery(policy, tool, args) {
  if (!policy) return undefined;
  try {
    const reason = await policy({ tool, args: args ?? {} });
    return reason ? String(reason) : undefined;
  } catch (err) {
    return `the query policy failed on this call (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** The message the model reads for a refused call. */
export function refusalText(tool, reason) {
  return `${tool} was refused by this deployment's query policy: ${reason}`;
}
