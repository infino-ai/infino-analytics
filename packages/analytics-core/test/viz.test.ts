import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { NewVisualizationSchema, mergePatch, newVisualization } from "../src/viz.js";
import type { Visualization } from "../src/viz.js";

const doc = (): Visualization =>
  newVisualization(
    NewVisualizationSchema.parse({
      title: "Events by day",
      source: { kind: "sql", table: "events", raw_query: "SELECT day, n FROM events" },
      chart: { type: "bar" },
      mapping: { x: "day", y: ["n"] },
      tags: ["ops"],
    }),
  );

describe("mergePatch", () => {
  it("merges objects deeply and replaces scalars", () => {
    const patched = mergePatch(doc(), { title: "Renamed", chart: { type: "line" } });
    strictEqual(patched.title, "Renamed");
    strictEqual(patched.chart.type, "line");
    strictEqual(patched.source.table, "events");
  });

  it("removes a key when the patch value is null", () => {
    const base = doc();
    base.description = "gone soon";
    const patched = mergePatch(base, { description: null });
    ok(!("description" in patched));
  });

  it("replaces arrays wholesale rather than merging them", () => {
    const patched = mergePatch(doc(), { mapping: { y: ["total"] } });
    deepStrictEqual(patched.mapping.y, ["total"]);
    strictEqual(patched.mapping.x, "day");
  });

  it("protects identity fields from the patch", () => {
    const base = doc();
    const patched = mergePatch(base, {
      id: "hijacked",
      schema_version: 99,
      created_at: "1999-01-01T00:00:00.000Z",
      created_by: "someone-else",
    });
    strictEqual(patched.id, base.id);
    strictEqual(patched.schema_version, base.schema_version);
    strictEqual(patched.created_at, base.created_at);
  });

  it("stamps updated_at on every patch", () => {
    const base = { ...doc(), updated_at: "1999-01-01T00:00:00.000Z" };
    const patched = mergePatch(base, { title: "x" });
    notStrictEqual(patched.updated_at, base.updated_at);
  });

  it("leaves the original document untouched", () => {
    const base = doc();
    mergePatch(base, { title: "Renamed" });
    strictEqual(base.title, "Events by day");
  });
});
