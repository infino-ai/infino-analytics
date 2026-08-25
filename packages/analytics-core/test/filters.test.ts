import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { injectFilters, mergeFilters, timeRangeFilter } from "../src/filters.js";
import type { Filter } from "../src/viz.js";

const filter = (over: Partial<Filter> & Pick<Filter, "field" | "operator">): Filter => ({
  value: null,
  enabled: true,
  ...over,
}) as Filter;

describe("mergeFilters", () => {
  it("lets a request filter win over a saved one on the same field", () => {
    const merged = mergeFilters(
      [filter({ field: "status", operator: "is", value: "open" }), filter({ field: "team", operator: "is", value: "a" })],
      [filter({ field: "status", operator: "is", value: "closed" })],
    );
    deepStrictEqual(
      merged.map((f) => [f.field, f.value]),
      [["team", "a"], ["status", "closed"]],
    );
  });
});

describe("timeRangeFilter", () => {
  it("defaults to @timestamp when the spec declares no time column", () => {
    const f = timeRangeFilter({ from: "2024-01-01", to: "2024-02-01" }, undefined);
    strictEqual(f.field, "@timestamp");
    strictEqual(f.operator, "is_between");
    strictEqual(f.is_time_filter, true);
  });
});

describe("injectFilters", () => {
  it("returns the SQL untouched when nothing is active", () => {
    const sql = "SELECT a FROM t";
    const out = injectFilters(sql, [filter({ field: "x", operator: "is", value: 1, enabled: false })]);
    deepStrictEqual(out, { sql, applied: [], skipped: [] });
  });

  it("AND-injects a predicate into an existing WHERE", () => {
    const out = injectFilters("SELECT a FROM t WHERE a > 1", [
      filter({ field: "status", operator: "is", value: "open" }),
    ]);
    deepStrictEqual(out.applied, ["status"]);
    deepStrictEqual(out.skipped, []);
    match(out.sql, /WHERE/i);
    match(out.sql, /"status" = 'open'/);
    match(out.sql, /AND/i);
  });

  it("escapes quotes in string literals rather than breaking out of them", () => {
    const out = injectFilters("SELECT a FROM t", [
      filter({ field: "name", operator: "is", value: "O'Brien" }),
    ]);
    deepStrictEqual(out.applied, ["name"]);
    match(out.sql, /'O''Brien'/);
  });

  it("skips one bad filter without poisoning the rest", () => {
    const out = injectFilters("SELECT a FROM t", [
      filter({ field: "ok", operator: "is", value: 1 }),
      filter({ field: "bad field!", operator: "is", value: 1 }),
    ]);
    deepStrictEqual(out.applied, ["ok"]);
    strictEqual(out.skipped.length, 1);
    strictEqual(out.skipped[0].filter, "bad field!");
  });

  // Degrade, never fail: the contract every renderer and the agent rely on.
  it("runs the original query when the SQL itself will not parse", () => {
    const sql = "NOT SQL AT ALL {{";
    const out = injectFilters(sql, [filter({ field: "status", operator: "is", value: "open" })]);
    strictEqual(out.sql, sql);
    deepStrictEqual(out.applied, []);
    strictEqual(out.skipped.length, 1);
    match(out.skipped[0].reason, /^sql_parse_error:/);
  });

  it("refuses to inject into a non-SELECT", () => {
    const sql = "DELETE FROM t";
    const out = injectFilters(sql, [filter({ field: "status", operator: "is", value: "open" })]);
    strictEqual(out.sql, sql);
    deepStrictEqual(out.applied, []);
    match(out.skipped[0].reason, /sql_parse_error/);
  });

  it("builds IN, BETWEEN, NULL and LIKE predicates", () => {
    const out = injectFilters("SELECT a FROM t", [
      filter({ field: "team", operator: "is_one_of", value: ["a", "b"] }),
      filter({ field: "n", operator: "is_between", value: { from: 1, to: 5 } }),
      filter({ field: "gone", operator: "does_not_exist" }),
      filter({ field: "note", operator: "contains", value: "cat" }),
    ]);
    deepStrictEqual(out.skipped, []);
    match(out.sql, /"team" IN \('a', 'b'\)/);
    match(out.sql, /"n" >= 1 AND "n" <= 5/);
    match(out.sql, /"gone" IS NULL/);
    match(out.sql, /"note" LIKE '%cat%'/);
  });
});
