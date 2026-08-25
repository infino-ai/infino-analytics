import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { InfinoClient } from "../src/client.js";
import { execute } from "../src/execute.js";
import { VizSpecSchema } from "../src/spec.js";
import type { VizSpec } from "../src/spec.js";

/** Engine stand-in: InfinoClient has private fields, so a structural fake
 * will not type-check — subclass and override the one network method. */
class FakeClient extends InfinoClient {
  lastQuery = "";
  constructor(private readonly rows: Record<string, unknown>[]) {
    super({ uri: "https://example.test/db", apiKey: "test" });
  }
  override async querySql(query: string): Promise<Record<string, unknown>[]> {
    this.lastQuery = query;
    return this.rows;
  }
}

const spec = (over: Record<string, unknown>): VizSpec =>
  VizSpecSchema.parse({
    title: "t",
    source: { kind: "sql", table: "t", raw_query: "SELECT * FROM t" },
    chart: { type: "bar" },
    ...over,
  });

const codes = (r: { metadata: { warnings: { code: string }[] } }) =>
  r.metadata.warnings.map((w) => w.code);

describe("execute", () => {
  it("binds x and y to the actual result columns", async () => {
    const client = new FakeClient([{ day: "mon", n: 3 }, { day: "tue", n: 5 }]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }));
    deepStrictEqual(result.metadata.binding.x, "day");
    deepStrictEqual(result.metadata.binding.y, ["n"]);
    deepStrictEqual(codes(result), []);
    strictEqual(result.metadata.row_count, 2);
  });

  // Engines fold aliases; the binding must survive that, not the spec's casing.
  it("resolves a column case-insensitively and reports the engine's name", async () => {
    const client = new FakeClient([{ DAY: "mon", N: 3 }]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }));
    strictEqual(result.metadata.binding.x, "DAY");
    deepStrictEqual(result.metadata.binding.y, ["N"]);
  });

  it("warns and infers y when the declared column is absent", async () => {
    const client = new FakeClient([{ day: "mon", total: 3 }]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["nope"] } }));
    ok(codes(result).includes("y_column_not_found"));
    ok(codes(result).includes("y_inferred"));
    deepStrictEqual(result.metadata.binding.y, ["total"]);
  });

  it("warns instead of throwing when x cannot be resolved", async () => {
    const client = new FakeClient([{ day: "mon", n: 3 }]);
    const result = await execute(client, spec({ mapping: { x: "missing", y: ["n"] } }));
    strictEqual(result.metadata.binding.x, null);
    ok(codes(result).includes("x_column_not_found"));
    strictEqual(result.rows.length, 1);
  });

  it("truncates at the row cap and says so", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ day: String(i), n: i }));
    const client = new FakeClient(rows);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }));
    strictEqual(result.metadata.truncated, true);
    strictEqual(result.rows.length, 5000);
    ok(codes(result).includes("result_truncated"));
  });

  it("reports an empty result rather than failing", async () => {
    const client = new FakeClient([]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }));
    deepStrictEqual(codes(result), ["empty_result"]);
    deepStrictEqual(result.columns, []);
  });

  it("resolves a metric to the sole numeric column", async () => {
    const client = new FakeClient([{ label: "all", total: 42 }]);
    const result = await execute(client, spec({ chart: { type: "metric" }, mapping: { y: [] } }));
    strictEqual(result.metadata.binding.value, "total");
  });

  it("drops y2 when series already pivots the rows", async () => {
    const client = new FakeClient([{ day: "mon", n: 3, rate: 0.5, team: "a" }]);
    const result = await execute(
      client,
      spec({ chart: { type: "combo" }, mapping: { x: "day", y: ["n"], y2: ["rate"], series: "team" } }),
    );
    deepStrictEqual(result.metadata.binding.y2, []);
    ok(codes(result).includes("y2_ignored_with_series"));
  });

  it("flags a heatmap with no row axis", async () => {
    const client = new FakeClient([{ hour: "1", n: 3 }]);
    const result = await execute(client, spec({ chart: { type: "heatmap" }, mapping: { x: "hour", y: ["n"] } }));
    ok(codes(result).includes("heatmap_needs_series"));
  });

  it("injects runtime filters into the executed query and records the receipt", async () => {
    const client = new FakeClient([{ day: "mon", n: 3 }]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }), {
      filters: [{ field: "team", operator: "is", value: "a", enabled: true, is_time_filter: false }],
    });
    deepStrictEqual(result.metadata.filters_applied, ["team"]);
    deepStrictEqual(result.metadata.filters_skipped, []);
    ok(client.lastQuery.includes(`"team" = 'a'`));
    strictEqual(result.metadata.executed_query, client.lastQuery);
  });

  it("skips an uninjectable filter and still returns data", async () => {
    const client = new FakeClient([{ day: "mon", n: 3 }]);
    const result = await execute(client, spec({ mapping: { x: "day", y: ["n"] } }), {
      filters: [{ field: "bad field!", operator: "is", value: "a", enabled: true, is_time_filter: false }],
    });
    deepStrictEqual(result.metadata.filters_applied, []);
    strictEqual(result.metadata.filters_skipped.length, 1);
    strictEqual(result.rows.length, 1);
  });
});
