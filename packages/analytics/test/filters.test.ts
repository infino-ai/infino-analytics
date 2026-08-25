import { deepStrictEqual, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { Analytics } from "../src/index.js";

/** Saved filters are parsed on write; request filters used to reach the SQL
 * builder unchecked, where an unknown operator became an sql_parse_error
 * receipt that blamed the query. A zero-panel dashboard exercises the check
 * without a query. */
const analytics = () => new Analytics({ infino: { uri: "https://example.test/db", apiKey: "test" } });

const emptyDashboard = async (a: Analytics) => (await a.dashboards.create({ title: "d", panels: [] })).id;

describe("request filter validation", () => {
  it("rejects an out-of-vocabulary operator", async () => {
    const a = analytics();
    const id = await emptyDashboard(a);
    await rejects(
      () => a.dashboards.execute(id, { filters: [{ field: "points", operator: "greater_than", value: 1 }] as never }),
      /operator/i,
    );
  });

  it("rejects a filter missing its field", async () => {
    const a = analytics();
    const id = await emptyDashboard(a);
    await rejects(() => a.dashboards.execute(id, { filters: [{ operator: "is", value: 1 }] as never }), /field/i);
  });

  it("accepts the documented vocabulary", async () => {
    const a = analytics();
    const id = await emptyDashboard(a);
    const out = await a.dashboards.execute(id, {
      filters: [
        { field: "author", operator: "is", value: "pg" },
        { field: "points", operator: "is_between", value: { from: 1, to: 5 } },
        { field: "title", operator: "contains", value: "rust" },
        { field: "author", operator: "exists" },
      ] as never,
    });
    deepStrictEqual(out, []);
  });
});
