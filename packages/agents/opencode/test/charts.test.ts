import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatEvent, InfinoClient } from "@infino-ai/analytics-core";
import { ChartLedger, fitReceipt, startChartServer } from "../src/charts.js";

// The chart server end to end over real HTTP MCP, with only the Infino client
// faked.
const ROWS = [
  { domain: "en", n: 3 },
  { domain: "de", n: 2 },
];
const infino = {
  querySql: async (sql: string) => {
    if (sql.includes("missing")) throw new Error("no such table");
    return ROWS;
  },
} as unknown as InfinoClient;

async function call(url: string, args: Record<string, unknown>) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const result = await client.callTool({ name: "create_chart", arguments: args });
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0].text };
  } finally {
    await client.close();
  }
}

describe("chart server", async () => {
  const ledger = new ChartLedger();
  const server = await startChartServer(infino, ledger);
  after(async () => {
    ledger.close();
    await server.close();
  });

  it("rejects requests without the secret path", async () => {
    const res = await fetch(new URL("/mcp", server.url), { method: "POST" });
    strictEqual(res.status, 404);
  });

  it("rejects an oversized request body", async () => {
    const res = await fetch(server.url, { method: "POST", body: "x".repeat(1_100_000), headers: { "content-type": "application/json" } });
    strictEqual(res.status, 413);
  });

  it("parks a drawn chart's rows under the receipt the model gets, claimable once", async () => {
    const { isError, text } = await call(server.url, {
      title: "Views by domain",
      chart_type: "bar",
      table: "t",
      sql: "SELECT domain, COUNT(*) AS n FROM t GROUP BY domain",
      x: "domain",
      y: ["n"],
    });
    strictEqual(isError, false);
    const receipt = JSON.parse(text);
    deepStrictEqual(receipt.chart, { title: "Views by domain", type: "bar" });
    strictEqual(receipt.row_count, 2);

    const events = ledger.claim(text);
    deepStrictEqual(events.map((e) => e.type), ["sql", "chart"]);
    const chart = events[1] as Extract<ChatEvent, { type: "chart" }>;
    deepStrictEqual(chart.result.rows, ROWS, "the UI gets every row");
    deepStrictEqual(ledger.claim(text), [], "a receipt is claimable once");
  });

  it("parks a failed chart's SQL so the trace still shows it", async () => {
    const { isError, text } = await call(server.url, { title: "Rows", chart_type: "metric", table: "missing", sql: "SELECT COUNT(*) AS n FROM missing" });
    strictEqual(isError, true);
    const receipt = JSON.parse(text);
    deepStrictEqual(receipt.chart, { title: "Rows", type: "metric" });
    ok(receipt.error.includes("no such table"));
    deepStrictEqual(ledger.claim(text), [{ type: "sql", query: "SELECT COUNT(*) AS n FROM missing" }]);
  });
});

describe("receipts", () => {
  it("leave a small receipt untouched", () => {
    const receipt = { chart: { title: "t" }, rendered: true, sample_rows: [{ a: 1 }] };
    strictEqual(fitReceipt(receipt), JSON.stringify(receipt));
  });

  it("shrink a large one under opencode's output limit, and say so", () => {
    const wide = Array.from({ length: 5 }, (_, i) => ({ id: i, embedding: "0.123,".repeat(5000), body: "word ".repeat(4000) }));
    const text = fitReceipt({ chart: { title: "t" }, rendered: true, row_count: 5, sample_rows: wide });
    ok(Buffer.byteLength(text) < 51_200, `receipt is ${Buffer.byteLength(text)} bytes`);
    const receipt = JSON.parse(text);
    strictEqual(receipt.row_count, 5, "facts about the result are kept");
    ok(receipt.sample_rows.length > 0);
    ok(String(receipt.sample_rows[0].embedding).endsWith("…"));
    ok(receipt.sample_note.includes("cut short"));
  });

  it("drop sample rows when shortening values is not enough", () => {
    const manyColumns = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`column_${i}`, "x".repeat(150)]));
    const text = fitReceipt({ chart: { title: "t" }, sample_rows: Array.from({ length: 5 }, () => manyColumns) });
    ok(Buffer.byteLength(text) < 51_200);
    const receipt = JSON.parse(text);
    ok(receipt.sample_rows.length < 5);
    ok(receipt.sample_note.startsWith(`sample cut to ${receipt.sample_rows.length} rows`));
  });
});

describe("chart ledger", () => {
  it("drops entries nobody claims within the TTL", () => {
    let now = 0;
    const ledger = new ChartLedger(1000, () => now);
    ledger.park("old", [{ type: "sql", query: "a" }]);
    now = 1500;
    deepStrictEqual(ledger.claim("old"), [], "expired on claim, not only on the next park");
    ledger.close();
  });

  it("does not park a chart with nothing to show", () => {
    const ledger = new ChartLedger();
    ledger.park("empty", []);
    ledger.park("empty", [{ type: "sql", query: "a" }]);
    deepStrictEqual(ledger.claim("empty"), [{ type: "sql", query: "a" }], "the empty one took no slot in the queue");
    ledger.close();
  });

  it("serves identical receipts in the order they were parked", () => {
    const ledger = new ChartLedger();
    ledger.park("same", [{ type: "sql", query: "a" }]);
    ledger.park("same", [{ type: "sql", query: "b" }]);
    deepStrictEqual(ledger.claim("same"), [{ type: "sql", query: "a" }]);
    deepStrictEqual(ledger.claim("same"), [{ type: "sql", query: "b" }]);
    deepStrictEqual(ledger.claim("same"), []);
    ledger.close();
  });

  it("claims nothing for output it never parked", () => {
    const ledger = new ChartLedger();
    deepStrictEqual(ledger.claim('{"rendered":true}'), []);
    deepStrictEqual(ledger.claim(undefined), []);
    ledger.close();
  });
});
