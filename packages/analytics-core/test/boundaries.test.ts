import { deepStrictEqual, ok } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The seam layout is a contract, and prose drifts faster than code: a peer
// named in a comment is how the coupling creeps back. This file makes the rule
// executable, the way assertHarnessConformance does for ChatEvent.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CLAUDE = /claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|bedrock|agent sdk/i;
const OPENAI = /openai|\bgpt\b|gpt-|azure|foundry|responses api/i;
const ANY_PROVIDER = new RegExp(`${CLAUDE.source}|${OPENAI.source}`, "i");

/** A harness may name its own provider; nothing else may name any. */
const RULES = [
  { dir: "packages/agents/openai", forbid: CLAUDE, what: "a peer harness's provider" },
  { dir: "packages/agents/claude", forbid: OPENAI, what: "a peer harness's provider" },
  { dir: "packages/analytics-core/src", forbid: ANY_PROVIDER, what: "any provider" },
  { dir: "packages/analytics/src", forbid: ANY_PROVIDER, what: "any provider" },
  { dir: "packages/storage-sqlite/src", forbid: ANY_PROVIDER, what: "any provider" },
  { dir: "apps/web/src", forbid: ANY_PROVIDER, what: "any provider" },
];

// The MCP SDK is transport, not a provider, and every harness speaks it.
const EXEMPT = /@modelcontextprotocol/;

/** Empty when the directory is absent — a fork deleting the harness it did not
 * pick is a supported state, not a failing rule. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules"))
    .map((f) => join(dir, f));
}

function offendingLines(file: string, forbid: RegExp): string[] {
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !EXEMPT.test(line) && forbid.test(line))
    .map(({ line, n }) => `${file}:${n} ${line.trim()}`);
}

describe("seam boundaries", () => {
  for (const { dir, forbid, what } of RULES) {
    it(`${dir} never names ${what}`, () => {
      const files = sourceFiles(dir);
      // A renamed directory would make this rule pass over nothing.
      ok(files.length > 0 || !existsSync(join(ROOT, dir)), `${dir}: no sources scanned`);
      deepStrictEqual(
        files.flatMap((f) => offendingLines(f, forbid)),
        [],
      );
    });
  }

  // The property that lets a fork carry one provider: installing the facade
  // must not install a harness. Guarding the manifest, not just the imports.
  it("the facade depends on no harness package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages/analytics/package.json"), "utf8"));
    deepStrictEqual(
      Object.keys(pkg.dependencies ?? {}).filter((d) => d.includes("analytics-agent-")),
      [],
    );
  });
});
