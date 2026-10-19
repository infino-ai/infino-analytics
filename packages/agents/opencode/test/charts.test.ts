import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { InfinoClient } from "@infino-ai/analytics-core";
import { ChartLedger, startChartServer } from "../src/charts.js";

// The chart server end to end over real HTTP MCP, with only the Infino client
// faked: the query fails, so runCreateChart parks its sql event and errors.
const failingInfino = {
  querySql: async () => {
    throw new Error("no such table");
  },
} as unknown as InfinoClient;

describe("chart server", async () => {
  const ledger = new ChartLedger();
  const server = await startChartServer(failingInfino, ledger);
  after(() => server.close());

  it("rejects requests without the secret path", async () => {
    const res = await fetch(new URL("/mcp", server.url), { method: "POST" });
    strictEqual(res.status, 404);
  });

  it("parks the UI events under the receipt it returns, claimable once", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try {
      const { tools } = await client.listTools();
      deepStrictEqual(tools.map((t) => t.name), ["create_chart"]);

      const result = await client.callTool({
        name: "create_chart",
        arguments: { title: "Rows", chart_type: "metric", table: "t", sql: "SELECT COUNT(*) AS n FROM t" },
      });
      strictEqual(result.isError, true);
      const text = (result.content as { text: string }[])[0].text;
      const receipt = JSON.parse(text);
      deepStrictEqual(receipt.chart, { title: "Rows", type: "metric" });
      ok(receipt.error.includes("no such table"));

      deepStrictEqual(ledger.claim(text), [{ type: "sql", query: "SELECT COUNT(*) AS n FROM t" }]);
      deepStrictEqual(ledger.claim(text), [], "a receipt is claimable once");
    } finally {
      await client.close();
    }
  });

  it("claims nothing for output it never parked", () => {
    deepStrictEqual(ledger.claim('{"rendered":true}'), []);
    deepStrictEqual(ledger.claim(undefined), []);
  });

  it("matches an output opencode truncated only when one receipt fits", () => {
    const l = new ChartLedger();
    const long = (tail: string) => `${"x".repeat(3000)}${tail}`;
    l.park(long("A"), [{ type: "sql", query: "a" }]);
    const truncated = "x".repeat(2500);
    deepStrictEqual(l.claim(truncated), [{ type: "sql", query: "a" }]);

    l.park(long("A"), [{ type: "sql", query: "a" }]);
    l.park(long("B"), [{ type: "sql", query: "b" }]);
    deepStrictEqual(l.claim(truncated), [], "two candidates: draw neither rather than guess");
  });

  it("rejects an oversized request body", async () => {
    const res = await fetch(server.url, { method: "POST", body: "x".repeat(1_100_000), headers: { "content-type": "application/json" } });
    strictEqual(res.status, 413);
  });

  it("serves identical receipts in the order they were parked", () => {
    const l = new ChartLedger();
    l.park("same", [{ type: "sql", query: "a" }]);
    l.park("same", [{ type: "sql", query: "b" }]);
    deepStrictEqual(l.claim("same"), [{ type: "sql", query: "a" }]);
    deepStrictEqual(l.claim("same"), [{ type: "sql", query: "b" }]);
    deepStrictEqual(l.claim("same"), []);
  });
});
