import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { CHART_TYPES, InfinoClient, type ChatEvent } from "@infino-ai/analytics-core";
import { toFunctionTool } from "../src/mcp.js";
import type { McpToolset } from "../src/mcp.js";
import { buildToolRegistry } from "../src/tools.js";

class FakeClient extends InfinoClient {
  constructor(private readonly rows: Record<string, unknown>[] = [{ day: "mon", n: 3 }]) {
    super({ uri: "https://example.test/db", apiKey: "test" });
  }
  override async querySql(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }
}

const fakeMcp = (calls: { name: string; args: unknown }[] = []): McpToolset => ({
  tools: [toFunctionTool({ name: "infino_sql", description: "run sql", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } })],
  pid: null,
  async call(name, args) {
    calls.push({ name, args });
    return { text: "[]", isError: false };
  },
  async close() {},
});

const registry = (emit: (e: ChatEvent) => void = () => {}, calls: { name: string; args: unknown }[] = []) =>
  buildToolRegistry(fakeMcp(calls), new FakeClient(), emit);

describe("toFunctionTool", () => {
  it("carries an MCP schema through unchanged, minus $schema", () => {
    const tool = toFunctionTool({
      name: "infino_count",
      description: "count rows",
      inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { table: { type: "string" } } },
    });
    strictEqual(tool.type, "function");
    strictEqual(tool.name, "infino_count");
    strictEqual(tool.strict, false);
    ok(!("$schema" in (tool.parameters as object)));
    deepStrictEqual((tool.parameters as { properties: unknown }).properties, { table: { type: "string" } });
  });
});

describe("buildToolRegistry", () => {
  it("exposes the MCP tools plus create_chart", () => {
    deepStrictEqual(registry().definitions.map((t) => t.name), ["infino_sql", "create_chart"]);
  });

  it("describes create_chart with the shared contract text", () => {
    const chart = registry().definitions.find((t) => t.name === "create_chart");
    match(chart?.description ?? "", /the ONLY way to show data to the user/);
  });

  it("builds a create_chart schema Azure will accept", () => {
    const chart = registry().definitions.find((t) => t.name === "create_chart");
    const params = chart?.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    deepStrictEqual(params.properties.chart_type.enum, [...CHART_TYPES]);
    deepStrictEqual(params.required.sort(), ["chart_type", "sql", "table", "title"]);
    // $ref/$defs are not followed by the Responses validator.
    ok(!/\$ref|\$defs|\$schema/.test(JSON.stringify(chart)));
  });

  it("names every tool legally and uniquely", () => {
    const names = registry().definitions.map((t) => t.name);
    strictEqual(new Set(names).size, names.length);
    for (const name of names) match(name, /^[A-Za-z0-9_-]{1,64}$/);
  });

  it("routes an MCP tool to the MCP client", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const result = await registry(() => {}, calls).invoke("infino_sql", '{"query":"SELECT 1"}');
    deepStrictEqual(calls, [{ name: "infino_sql", args: { query: "SELECT 1" } }]);
    strictEqual(result.isError, false);
  });

  it("runs create_chart in process and emits its UI events", async () => {
    const emitted: ChatEvent[] = [];
    const result = await registry((e) => emitted.push(e)).invoke(
      "create_chart",
      JSON.stringify({ title: "Events", chart_type: "bar", table: "t", sql: "SELECT day, n FROM t", x: "day", y: ["n"] }),
    );
    deepStrictEqual(emitted.map((e) => e.type), ["sql", "chart"]);
    strictEqual(result.isError, false);
    // The model gets a receipt, not the rows.
    match(result.text, /"rendered":true/);
  });

  it("returns a model-readable error for unparseable arguments", async () => {
    const result = await registry().invoke("create_chart", "{not json");
    strictEqual(result.isError, true);
    match(result.text, /invalid tool arguments/);
  });

  it("returns an error for a tool that does not exist", async () => {
    const result = await registry().invoke("rm_rf", "{}");
    strictEqual(result.isError, true);
    match(result.text, /unknown tool: rm_rf/);
  });

  it("returns an error rather than throwing on an invalid chart spec", async () => {
    const result = await registry().invoke("create_chart", JSON.stringify({ title: "x" }));
    strictEqual(result.isError, true);
  });
});
