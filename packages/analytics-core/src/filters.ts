import pkg from "node-sql-parser";
import type { Filter, TimeRange } from "./viz.js";

// Runtime filter injection: parse the visualization's SQL to an AST,
// AND-inject each filter as a predicate into the outermost WHERE, and
// re-serialize. Degrade-never-fail throughout — a filter that can't be
// injected safely lands in `skipped` with a reason and the query still
// runs; consumers (the customer's UI, the agent) read the receipt and
// react.

const { Parser } = pkg;
const parser = new Parser();
const DIALECT = { database: "Postgresql" };

export interface InjectionResult {
  sql: string;
  /** Field names successfully injected. */
  applied: string[];
  skipped: { filter: string; reason: string }[];
}

/** Merge saved filters with request filters: request wins on field
 * collision. */
export function mergeFilters(saved: Filter[], request: Filter[]): Filter[] {
  const requestFields = new Set(request.map((f) => f.field));
  return [...saved.filter((f) => !requestFields.has(f.field)), ...request];
}

/** A time range is just a synthetic between-filter on the source's time
 * column (default "@timestamp"). */
export function timeRangeFilter(range: TimeRange, timeColumn: string | undefined): Filter {
  return {
    field: timeColumn ?? "@timestamp",
    operator: "is_between",
    value: { from: range.from, to: range.to },
    enabled: true,
    is_time_filter: true,
  };
}

export function injectFilters(sql: string, filters: Filter[]): InjectionResult {
  const active = filters.filter((f) => f.enabled !== false);
  if (active.length === 0) return { sql, applied: [], skipped: [] };

  const applied: string[] = [];
  const skipped: { filter: string; reason: string }[] = [];

  // Build each predicate independently so one bad filter never poisons
  // the rest.
  const predicates: string[] = [];
  for (const f of active) {
    try {
      predicates.push(predicateSql(f));
      applied.push(f.field);
    } catch (err) {
      skipped.push({ filter: f.field, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (predicates.length === 0) return { sql, applied: [], skipped };

  try {
    const ast = parser.astify(sql, DIALECT);
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    if ((stmt as { type?: string }).type !== "select") {
      throw new Error("not a SELECT statement");
    }
    // Parse the combined predicate through the same grammar, then graft it
    // onto the statement's WHERE.
    const predAst = parser.astify(
      `SELECT * FROM _t WHERE ${predicates.join(" AND ")}`,
      DIALECT,
    );
    const predStmt = Array.isArray(predAst) ? predAst[0] : predAst;
    const predWhere = (predStmt as { where: unknown }).where;
    const select = stmt as { where: unknown };
    select.where = select.where
      ? { type: "binary_expr", operator: "AND", left: select.where, right: predWhere }
      : predWhere;
    return { sql: parser.sqlify(stmt, DIALECT), applied, skipped };
  } catch (err) {
    // The SQL itself resisted parsing (or re-serialization): skip every
    // filter, run the original query.
    const reason = `sql_parse_error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    return {
      sql,
      applied: [],
      skipped: [...skipped, ...applied.map((field) => ({ filter: field, reason }))],
    };
  }
}

// ── predicate construction ─────────────────────────────────────────────────

function ident(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_@.]*$/.test(field)) {
    throw new Error(`unsupported field identifier: ${JSON.stringify(field)}`);
  }
  return `"${field}"`;
}

function literal(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`unsupported filter value: ${JSON.stringify(value)}`);
}

function betweenBounds(value: unknown): [unknown, unknown] {
  if (Array.isArray(value) && value.length === 2) return [value[0], value[1]];
  if (value !== null && typeof value === "object" && "from" in value && "to" in value) {
    const v = value as { from: unknown; to: unknown };
    return [v.from, v.to];
  }
  throw new Error("between filter needs [lo, hi] or {from, to}");
}

function predicateSql(f: Filter): string {
  const col = ident(f.field);
  switch (f.operator) {
    case "is":
      return `${col} = ${literal(f.value)}`;
    case "is_not":
      return `${col} <> ${literal(f.value)}`;
    case "is_one_of":
    case "is_not_one_of": {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        throw new Error(`${f.operator} needs a non-empty array value`);
      }
      const list = f.value.map(literal).join(", ");
      return f.operator === "is_one_of" ? `${col} IN (${list})` : `${col} NOT IN (${list})`;
    }
    case "is_between":
    case "is_not_between": {
      const [lo, hi] = betweenBounds(f.value);
      const range = `${col} >= ${literal(lo)} AND ${col} <= ${literal(hi)}`;
      return f.operator === "is_between" ? `(${range})` : `NOT (${range})`;
    }
    case "exists":
      return `${col} IS NOT NULL`;
    case "does_not_exist":
      return `${col} IS NULL`;
    case "contains": {
      if (typeof f.value !== "string" && typeof f.value !== "number") {
        throw new Error("contains needs a scalar value");
      }
      const escaped = String(f.value).replace(/'/g, "''").replace(/([%_])/g, "\\$1");
      return `${col} LIKE '%${escaped}%'`;
    }
  }
}
